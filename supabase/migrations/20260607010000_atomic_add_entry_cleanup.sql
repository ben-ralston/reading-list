-- Migration: Atomic add-entry create + transactional orphan cleanup (#176)
-- Description:
--   createContent (lib/sync/matching.ts) commits a content_items row, then
--   positions it in SEPARATE, non-transactional calls (insertAtSmartPosition).
--   A positioning failure left the row committed at queue_position=NULL /
--   status='' — an invisible orphan a retry matched as a duplicate and reported
--   as a green "success" (#176).
--
--   Moving the cleanup decision into the database (app-layer couldn't reliably
--   tell a brand-new row from a dedup target without racing / a trim mismatch):
--
--   1. upsert_content_item(...) — the canonical insert-or-dedup writer, now
--      RETURNS (content_id, inserted). `inserted` is TRUE only when a brand-new
--      content_items row was created (not when a source is attached to an
--      existing item), so the caller knows authoritatively whether IT inserted.
--      Body is the 15-arg version from 20260607000001 (feed-card enrichment,
--      #167) plus the inserted flag.
--
--   2. insert_or_update_content(...) is kept as a thin BIGINT wrapper over
--      upsert_content_item — SAME 15-arg signature as 20260607000001, so
--      CREATE OR REPLACE replaces it in place (no DROP, grants preserved, no
--      ambiguous overload). Keeps the stable scalar contract for callers that
--      only need the id (the Goodreads importer) and keeps any already-deployed
--      code working regardless of deploy order vs. this migration.
--
--   3. delete_orphan_content_item(id) deletes a never-positioned orphan
--      (status='' AND queue_position IS NULL) under a row lock (FOR UPDATE),
--      sources-first, in one transaction — so a concurrent positioning UPDATE
--      can't race the check, and a positioned/in-progress/completed row is never
--      touched. Granted to service_role only (destructive, internal-only).
-- Date: 2026-06-07

-- 1. Canonical writer: full insert-or-dedup logic + feed-card enrichment (#167),
-- reports whether it inserted a brand-new content_items row.
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
  p_duration_seconds INT DEFAULT NULL
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
    -- New content: set queue_position, position_confirmed, added_by, kind, AND
    -- the feed-card enrichment fields (#167) here. Enrichment is INSERT-only.
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

COMMENT ON FUNCTION upsert_content_item(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, BIGINT, BOOLEAN, TEXT, TEXT, TEXT, TEXT, INT, INT) IS
'Insert or update content with deduplication and multi-source support.
Dedups by (title, author, kind) case-insensitive. Returns (content_id, inserted)
where inserted is TRUE only when a brand-new content_items row was created (not
when a source was attached to an existing item) — callers use it to decide
whether a post-insert failure left an orphan they may clean up (#176).
For new content, sets queue_position/position_confirmed/added_by/kind and the
feed-card enrichment fields (image_url, word_count, duration_seconds, #167),
all INSERT-only.';

GRANT EXECUTE ON FUNCTION upsert_content_item(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, BIGINT, BOOLEAN, TEXT, TEXT, TEXT, TEXT, INT, INT) TO anon, authenticated, service_role;

-- 2. Backward-compatible scalar wrapper. Same 15-arg signature/return (BIGINT)
-- as 20260607000001, so CREATE OR REPLACE keeps the existing grants and any
-- already-deployed code keeps getting a scalar id regardless of deploy order.
-- Callers that only need the id (the Goodreads importer) keep using this.
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

-- 3. Transactional, state-guarded cleanup for an orphaned (never-positioned) row
-- left by a positioning failure after the insert committed (#176). Locks the row
-- so a concurrent positioning UPDATE can't race the check; deletes sources first
-- (FK), then the item; only ever touches a row still in the pristine orphan
-- state. service_role only — destructive and internal-only (the app's server
-- routes use the service_role key).
CREATE OR REPLACE FUNCTION delete_orphan_content_item(p_id BIGINT)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_status TEXT;
  v_queue_position BIGINT;
BEGIN
  SELECT status, queue_position INTO v_status, v_queue_position
  FROM content_items
  WHERE id = p_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- Only a brand-new, never-positioned, untouched row (status defaults to '').
  -- Any positioned / in-progress / completed row is left alone.
  IF v_status IS DISTINCT FROM '' OR v_queue_position IS NOT NULL THEN
    RETURN FALSE;
  END IF;

  DELETE FROM content_sources WHERE content_item_id = p_id;
  DELETE FROM content_items WHERE id = p_id;
  RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION delete_orphan_content_item(BIGINT) TO service_role;
