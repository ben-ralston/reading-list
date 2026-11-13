-- Migration: Book metadata columns + agentic add enrichment (#186)
-- Description:
--   The Book Mode "Add book" flow gains an agentic LLM lookup (#186) that
--   fetches ISBN-13, subtitle, series, a Goodreads link, and a cover image.
--   This migration adds the three columns that don't yet exist (isbn13,
--   subtitle, series) and threads them through the canonical writer
--   upsert_content_item as INSERT-only fields — the same treatment the
--   feed-card enrichment fields (image_url, word_count, duration_seconds, #167)
--   already get. The cover image reuses the existing content_items.image_url
--   column (sibling to book covers, #168); no new column is needed for it.
--
--   Ordering note (mandatory): upsert_content_item is depended on by the scalar
--   wrapper insert_or_update_content (its body is SELECT ... FROM
--   upsert_content_item($1..$15)), and adding 3 params changes the function's
--   argument-type list from 15 to 18 — which makes a SECOND overload rather than
--   replacing in place (CREATE OR REPLACE only replaces an identical signature).
--   So we must, in order: (1) drop the dependent wrapper, (2) drop the 15-arg
--   upsert_content_item, (3) create the 18-arg upsert_content_item, (4) re-grant
--   it, (5) recreate the 15-arg wrapper over it, (6) re-grant the wrapper. This
--   mirrors the prior signature-bump migrations (20260526000001, 20260607000001,
--   20260607010000). DROP+CREATE drops grants, so both must be re-granted.
-- Date: 2026-06-21

-- 1. New columns. ALTER TABLE ADD COLUMN on an existing table inherits the
--    table's already-materialized grants — no new GRANT needed (per CLAUDE.md;
--    same as 20260607000000_add_feed_card_columns.sql). Stored TEXT: isbn13 must
--    preserve leading zeros / an 'X' check digit, so never numeric.
ALTER TABLE content_items ADD COLUMN isbn13 TEXT;
ALTER TABLE content_items ADD COLUMN subtitle TEXT;
ALTER TABLE content_items ADD COLUMN series TEXT;

COMMENT ON COLUMN content_items.isbn13 IS
  '#186 ISBN-13 (TEXT to preserve leading zeros / X check digit). Set by the agentic book add; INSERT-only via upsert_content_item.';
COMMENT ON COLUMN content_items.subtitle IS
  '#186 Book subtitle. Set by the agentic book add; INSERT-only via upsert_content_item.';
COMMENT ON COLUMN content_items.series IS
  '#186 Series name (and number if known). Set by the agentic book add; INSERT-only via upsert_content_item.';

-- 2. Drop the dependent WRAPPER FIRST. It hard-depends on the 15-arg
--    upsert_content_item, which therefore cannot be dropped while it exists.
DROP FUNCTION IF EXISTS insert_or_update_content(
  TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, BIGINT, BOOLEAN, TEXT, TEXT, TEXT, TEXT, INT, INT
);

-- 3. Drop the 15-arg upsert_content_item so the 18-arg version below is the only
--    overload (a positional call to an ambiguous overload set errors out).
DROP FUNCTION IF EXISTS upsert_content_item(
  TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, BIGINT, BOOLEAN, TEXT, TEXT, TEXT, TEXT, INT, INT
);

-- 4. Recreate the canonical writer with the 3 new book-metadata params appended
--    (DEFAULT NULL) after p_duration_seconds. Body is the 20260607010000 version
--    with isbn13/subtitle/series added INSERT-only to the new-item INSERT (the
--    existing-item branch never overwrites them, same as the other enrichment).
CREATE OR REPLACE FUNCTION upsert_content_item(
  p_title TEXT,
  p_author TEXT,
  p_platform TEXT,
  p_link TEXT,
  p_published_on TIMESTAMPTZ DEFAULT NULL,
  p_message_id TEXT DEFAULT NULL,
  p_is_primary BOOLEAN DEFAULT FALSE,
  p_queue_position BIGINT DEFAULT NULL,
  p_position_confirmed BOOLEAN DEFAULT FALSE,
  p_external_id TEXT DEFAULT NULL,
  p_added_by TEXT DEFAULT NULL,
  p_kind TEXT DEFAULT 'feed',
  p_image_url TEXT DEFAULT NULL,
  p_word_count INT DEFAULT NULL,
  p_duration_seconds INT DEFAULT NULL,
  p_isbn13 TEXT DEFAULT NULL,
  p_subtitle TEXT DEFAULT NULL,
  p_series TEXT DEFAULT NULL
)
RETURNS TABLE(content_id BIGINT, inserted BOOLEAN)
LANGUAGE plpgsql
AS $$
DECLARE
  v_content_id BIGINT;
  v_inserted BOOLEAN := FALSE;  -- TRUE only when a new content_items row is created
  v_source_exists BOOLEAN;
  v_existing_source_id BIGINT;
  v_has_primary BOOLEAN;
  v_final_is_primary BOOLEAN;
  v_link TEXT;
  v_kind TEXT;
BEGIN
  -- Required parameters
  IF p_title IS NULL OR TRIM(p_title) = '' THEN
    RAISE EXCEPTION 'Title is required';
  END IF;
  IF p_author IS NULL OR TRIM(p_author) = '' THEN
    RAISE EXCEPTION 'Author is required';
  END IF;
  IF p_platform IS NULL OR TRIM(p_platform) = '' THEN
    RAISE EXCEPTION 'Platform is required';
  END IF;

  -- Normalize empty/whitespace link to NULL (Physical / Library / Other have none).
  v_link := NULLIF(TRIM(COALESCE(p_link, '')), '');

  -- Default kind; the CHECK constraint on content_items.kind enforces the set.
  v_kind := COALESCE(NULLIF(TRIM(p_kind), ''), 'feed');

  -- Dedup by case-insensitive (title, author) WITHIN the same kind (#147).
  SELECT id INTO v_content_id
  FROM content_items
  WHERE LOWER(TRIM(title)) = LOWER(TRIM(p_title))
    AND LOWER(TRIM(author)) = LOWER(TRIM(p_author))
    AND kind = v_kind
  LIMIT 1;

  IF v_content_id IS NULL THEN
    -- New content: set queue_position, position_confirmed, added_by, kind, the
    -- feed-card enrichment fields (#167) AND the book-metadata fields (#186)
    -- here. All enrichment is INSERT-only.
    INSERT INTO content_items (
      title,
      author,
      published_on,
      queue_position,
      position_confirmed,
      added_by,
      kind,
      image_url,
      word_count,
      duration_seconds,
      isbn13,
      subtitle,
      series
    )
    VALUES (
      TRIM(p_title),
      TRIM(p_author),
      p_published_on,
      p_queue_position,
      p_position_confirmed,
      p_added_by,
      v_kind,
      p_image_url,
      p_word_count,
      p_duration_seconds,
      p_isbn13,
      p_subtitle,
      p_series
    )
    RETURNING id INTO v_content_id;

    v_inserted := TRUE;

    -- First source for new content is always primary.
    v_final_is_primary := TRUE;
  ELSE
    -- Existing content: never overwrite kind/queue_position/position_confirmed/
    -- added_by/enrichment — only consider attaching/refreshing a source.
    --
    -- Step 1: does this exact source already exist? NULL link treated equal to
    -- NULL via IS NOT DISTINCT FROM.
    SELECT EXISTS(
      SELECT 1 FROM content_sources
      WHERE content_item_id = v_content_id
        AND platform = p_platform
        AND link IS NOT DISTINCT FROM v_link
    ) INTO v_source_exists;

    IF v_source_exists THEN
      content_id := v_content_id;
      inserted := v_inserted;  -- FALSE: deduped, nothing inserted
      RETURN NEXT;
      RETURN;
    END IF;

    -- Step 2: an (item, platform) source exists but with a different link.
    -- Update it (handles re-published Spotify episodes). Skip when p_link is NULL
    -- so we don't erase a real URL on a physical-format source.
    IF v_link IS NOT NULL THEN
      SELECT id INTO v_existing_source_id
      FROM content_sources
      WHERE content_item_id = v_content_id
        AND platform = p_platform
      LIMIT 1;

      IF v_existing_source_id IS NOT NULL THEN
        UPDATE content_sources
        SET link = v_link, external_id = p_external_id
        WHERE id = v_existing_source_id;
        content_id := v_content_id;
        inserted := v_inserted;  -- FALSE
        RETURN NEXT;
        RETURN;
      END IF;
    END IF;

    -- Step 3: deciding the new source's primary flag.
    SELECT EXISTS(
      SELECT 1 FROM content_sources
      WHERE content_item_id = v_content_id
        AND is_primary = TRUE
    ) INTO v_has_primary;

    IF p_is_primary THEN
      v_final_is_primary := TRUE;
      UPDATE content_sources
        SET is_primary = FALSE
        WHERE content_item_id = v_content_id;
    ELSIF NOT v_has_primary THEN
      v_final_is_primary := CASE
        WHEN p_platform = 'Spotify' THEN TRUE
        WHEN p_platform = 'YouTube' THEN TRUE
        WHEN p_platform = 'Podcast' THEN TRUE
        ELSE FALSE
      END;
    ELSE
      v_final_is_primary := FALSE;
    END IF;
  END IF;

  INSERT INTO content_sources (
    content_item_id,
    platform,
    link,
    message_id,
    is_primary,
    external_id
  )
  VALUES (
    v_content_id,
    p_platform,
    v_link,
    p_message_id,
    v_final_is_primary,
    p_external_id
  );

  content_id := v_content_id;
  inserted := v_inserted;  -- TRUE iff a new content_items row was created above
  RETURN NEXT;
  RETURN;
END;
$$;

COMMENT ON FUNCTION upsert_content_item(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, BIGINT, BOOLEAN, TEXT, TEXT, TEXT, TEXT, INT, INT, TEXT, TEXT, TEXT) IS
'Insert or update content with deduplication and multi-source support.
Dedups by (title, author, kind) case-insensitive. Returns (content_id, inserted)
where inserted is TRUE only when a brand-new content_items row was created (not
when a source was attached to an existing item) — callers use it to decide
whether a post-insert failure left an orphan they may clean up (#176).
For new content, sets queue_position/position_confirmed/added_by/kind, the
feed-card enrichment fields (image_url, word_count, duration_seconds, #167), and
the book-metadata fields (isbn13, subtitle, series, #186) — all INSERT-only.';

GRANT EXECUTE ON FUNCTION upsert_content_item(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, BIGINT, BOOLEAN, TEXT, TEXT, TEXT, TEXT, INT, INT, TEXT, TEXT, TEXT) TO anon, authenticated, service_role;

-- 5. Recreate the backward-compatible scalar wrapper. Kept at the SAME 15-arg
--    signature so the Goodreads importer and any other scalar caller are
--    unchanged; the 3 new book fields default to NULL for them. The call resolves
--    to the 18-arg function (only overload) with the trailing 3 defaults.
CREATE OR REPLACE FUNCTION insert_or_update_content(
  p_title TEXT,
  p_author TEXT,
  p_platform TEXT,
  p_link TEXT,
  p_published_on TIMESTAMPTZ DEFAULT NULL,
  p_message_id TEXT DEFAULT NULL,
  p_is_primary BOOLEAN DEFAULT FALSE,
  p_queue_position BIGINT DEFAULT NULL,
  p_position_confirmed BOOLEAN DEFAULT FALSE,
  p_external_id TEXT DEFAULT NULL,
  p_added_by TEXT DEFAULT NULL,
  p_kind TEXT DEFAULT 'feed',
  p_image_url TEXT DEFAULT NULL,
  p_word_count INT DEFAULT NULL,
  p_duration_seconds INT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE sql
AS $$
  SELECT content_id FROM upsert_content_item(
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
  );
$$;

GRANT EXECUTE ON FUNCTION insert_or_update_content(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, BIGINT, BOOLEAN, TEXT, TEXT, TEXT, TEXT, INT, INT) TO anon, authenticated, service_role;
