-- Migration: Extend insert_or_update_content with feed-card enrichment fields (#167)
-- Description:
--   Adds optional p_image_url / p_word_count / p_duration_seconds, applied only on
--   INSERT — existing items' enrichment is never overwritten by the upsert path,
--   matching how kind / queue_position / added_by behave. New columns added in
--   20260607000000. Body is otherwise identical to 20260530000000
--   (kind-scoped dedup + multi-source attach/refresh).
--
--   Drop the prior (12-arg) signature first so the new (15-arg) version isn't an
--   ambiguous overload (3 trailing DEFAULT NULL params would let a 12-arg call
--   match both). Existing positional callers resolve cleanly to the new defaulted
--   signature after this migration. Mirrors the 11->12 DROP in 20260526000001.
-- Date: 2026-06-07

DROP FUNCTION IF EXISTS insert_or_update_content(
  TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, BIGINT, BOOLEAN, TEXT, TEXT, TEXT
);

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
) RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_content_id BIGINT;
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

  -- Normalize empty/whitespace link to NULL. NULL link is fine: Physical /
  -- Library / Other book sources have no URL.
  v_link := NULLIF(TRIM(COALESCE(p_link, '')), '');

  -- Default kind. The CHECK constraint on content_items.kind enforces the
  -- allowed set; an unknown value will raise here at INSERT.
  v_kind := COALESCE(NULLIF(TRIM(p_kind), ''), 'feed');

  -- Dedup by case-insensitive (title, author) WITHIN the same kind (#147).
  -- Without the kind clause, a Goodreads book would match a same-titled feed
  -- item and attach to it instead of creating a book row.
  SELECT id INTO v_content_id
  FROM content_items
  WHERE LOWER(TRIM(title)) = LOWER(TRIM(p_title))
    AND LOWER(TRIM(author)) = LOWER(TRIM(p_author))
    AND kind = v_kind
  LIMIT 1;

  IF v_content_id IS NULL THEN
    -- New content: set queue_position, position_confirmed, added_by, kind, AND
    -- the feed-card enrichment fields (#167) here. Enrichment is INSERT-only:
    -- existing rows keep whatever image/length they already have.
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
      duration_seconds
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
      p_duration_seconds
    )
    RETURNING id INTO v_content_id;

    -- First source for new content is always primary.
    v_final_is_primary := TRUE;
  ELSE
    -- Existing content: never overwrite kind, queue_position, position_confirmed,
    -- added_by, or the enrichment fields — only consider attaching/refreshing a source.
    --
    -- Step 1: does this exact source already exist? NULL link is treated equal
    -- to NULL via IS NOT DISTINCT FROM.
    SELECT EXISTS(
      SELECT 1 FROM content_sources
      WHERE content_item_id = v_content_id
        AND platform = p_platform
        AND link IS NOT DISTINCT FROM v_link
    ) INTO v_source_exists;

    IF v_source_exists THEN
      RETURN v_content_id;
    END IF;

    -- Step 2: an (item, platform) source exists but with a different link.
    -- Update it (handles re-published Spotify episodes; preserves the
    -- behavior added in 20260212000001). Skip this branch when p_link is NULL
    -- so we don't accidentally erase a real URL on a physical-format source.
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
        RETURN v_content_id;
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

  RETURN v_content_id;
END;
$$;

COMMENT ON FUNCTION insert_or_update_content(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, BIGINT, BOOLEAN, TEXT, TEXT, TEXT, TEXT, INT, INT) IS
'Insert or update content with deduplication and multi-source support.
Dedups by (title, author, kind) case-insensitive. For new content, sets
queue_position, position_confirmed, added_by, kind, and the feed-card enrichment
fields (image_url, word_count, duration_seconds) on the inserted row.
For existing content, never overwrites kind / queue_position / position_confirmed
/ added_by / enrichment fields — only attaches a new source, or refreshes the
link+external_id on an existing (item, platform) source when a different URL is supplied.

p_link may be NULL/empty for sources like "Physical" that have no URL.
p_kind defaults to ''feed'' and is only applied on INSERT; dedup is scoped to it.
Enrichment params (image_url, word_count, duration_seconds) are INSERT-only (#167).';

GRANT EXECUTE ON FUNCTION insert_or_update_content(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, BIGINT, BOOLEAN, TEXT, TEXT, TEXT, TEXT, INT, INT) TO anon, authenticated, service_role;
