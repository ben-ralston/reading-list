-- Migration: DB-level dedup for content_items (write integrity, #207 / RLV-023)
-- Description: upsert_content_item deduped via an unprotected SELECT-then-INSERT
--   on (LOWER(TRIM(title)), LOWER(TRIM(author)), kind), so concurrent calls
--   (double-tap "Save to Reading List", overlapping rss-/spotify-sync crons)
--   both missed the check and inserted duplicate rows. This migration:
--     1. merges any duplicate content_items groups (defensive — prod had zero
--        on 2026-07-11, but the race is live until this deploys),
--     2. adds a unique expression index on the dedup key, and
--     3. replaces upsert_content_item with a race-safe create path
--        (INSERT ... ON CONFLICT DO NOTHING + re-select of the winner).
--
-- Grants: CREATE OR REPLACE (no DROP — the 18-arg signature is unchanged)
--   preserves the function's existing privileges. The explicit GRANT below
--   re-states the post-#205 posture (migration 20260710000000): service_role
--   only; anon/authenticated are deliberately locked out of the whole schema.
--   The scalar insert_or_update_content wrapper is untouched — it delegates
--   to this function and its signature still matches.

-- ============================================================================
-- 1. MERGE DUPLICATE content_items (idempotent; no-op when there are none)
-- ============================================================================
-- Pattern from 20251123230001_merge_duplicate_content.sql, extended:
--   * the group key includes kind, matching the RPC's dedup key (#147), and
--   * feedback rows are repointed to the keeper first — their FK is
--     ON DELETE CASCADE, so deleting a duplicate would silently drop them.
-- Keeper: best status (Completed > In Progress > Skip > '') then lowest id.

DO $$
DECLARE
  dup_group RECORD;
  keep_id BIGINT;
  dup_id BIGINT;
  dup_ids BIGINT[];
  moved INT;
  groups_merged INT := 0;
  sources_moved INT := 0;
  feedback_moved INT := 0;
  items_deleted INT := 0;
BEGIN
  FOR dup_group IN
    SELECT array_agg(id ORDER BY
      CASE status
        WHEN 'Completed' THEN 1
        WHEN 'In Progress' THEN 2
        WHEN 'Skip' THEN 3
        ELSE 4
      END,
      id
    ) AS ids
    FROM content_items
    GROUP BY LOWER(TRIM(title)), LOWER(TRIM(author)), kind
    HAVING COUNT(*) > 1
  LOOP
    keep_id := dup_group.ids[1];
    dup_ids := dup_group.ids[2:];

    FOREACH dup_id IN ARRAY dup_ids
    LOOP
      -- Move sources the keeper doesn't already have (NULL-safe link compare,
      -- mirroring the RPC's IS NOT DISTINCT FROM dedup); drop the rest.
      -- The second NOT-EXISTS mirrors content_sources_item_platform_idx
      -- (UNIQUE (content_item_id, platform) WHERE external_id IS NOT NULL,
      -- 20260103000001): moving a non-null-external_id source onto a keeper
      -- that already has one for the same platform would abort the whole
      -- migration transaction — the keeper's source wins instead.
      UPDATE content_sources
      SET content_item_id = keep_id,
          is_primary = FALSE
      WHERE content_item_id = dup_id
        AND NOT EXISTS (
          SELECT 1 FROM content_sources cs2
          WHERE cs2.content_item_id = keep_id
            AND cs2.platform = content_sources.platform
            AND cs2.link IS NOT DISTINCT FROM content_sources.link
        )
        AND NOT (
          content_sources.external_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM content_sources cs3
            WHERE cs3.content_item_id = keep_id
              AND cs3.platform = content_sources.platform
              AND cs3.external_id IS NOT NULL
          )
        );
      GET DIAGNOSTICS moved = ROW_COUNT;
      sources_moved := sources_moved + moved;

      DELETE FROM content_sources WHERE content_item_id = dup_id;

      UPDATE feedback SET content_item_id = keep_id WHERE content_item_id = dup_id;
      GET DIAGNOSTICS moved = ROW_COUNT;
      feedback_moved := feedback_moved + moved;

      DELETE FROM content_items WHERE id = dup_id;
      items_deleted := items_deleted + 1;
    END LOOP;

    groups_merged := groups_merged + 1;
  END LOOP;

  RAISE NOTICE 'write-integrity dedup: % groups merged, % sources moved, % feedback rows repointed, % items deleted',
    groups_merged, sources_moved, feedback_moved, items_deleted;
END $$;

-- ============================================================================
-- 2. UNIQUE EXPRESSION INDEX ON THE DEDUP KEY
-- ============================================================================
-- Plain (not CONCURRENTLY: migrations run in a transaction and the table is
-- ~1.4k rows) and not partial (every row participates; title/author are
-- required by the RPC and non-null on all prod rows).

CREATE UNIQUE INDEX IF NOT EXISTS content_items_title_author_kind_uniq
  ON content_items (LOWER(TRIM(title)), LOWER(TRIM(author)), kind);

-- ============================================================================
-- 3. RACE-SAFE upsert_content_item
-- ============================================================================
-- Identical to the 20260621000000 version except the create path: the INSERT
-- now targets the unique index with ON CONFLICT DO NOTHING, and a call that
-- loses the race re-selects the winner (its transaction has committed by the
-- time ON CONFLICT resolves) and falls into the attach-source path.

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
    -- here. All enrichment is INSERT-only. ON CONFLICT (#207): a concurrent
    -- call may have created the row after the SELECT above — the unique index
    -- content_items_title_author_kind_uniq makes this INSERT lose cleanly
    -- instead of duplicating.
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
    ON CONFLICT (LOWER(TRIM(title)), LOWER(TRIM(author)), kind) DO NOTHING
    RETURNING id INTO v_content_id;

    IF v_content_id IS NOT NULL THEN
      v_inserted := TRUE;

      -- First source for new content is always primary.
      v_final_is_primary := TRUE;
    ELSE
      -- Lost the create race: ON CONFLICT resolved against a row whose
      -- transaction has committed, so a fresh snapshot must see it. Fall
      -- through to the existing-content path below.
      SELECT id INTO v_content_id
      FROM content_items
      WHERE LOWER(TRIM(title)) = LOWER(TRIM(p_title))
        AND LOWER(TRIM(author)) = LOWER(TRIM(p_author))
        AND kind = v_kind
      LIMIT 1;

      IF v_content_id IS NULL THEN
        -- Winner's row vanished between conflict and re-read (deleted by a
        -- concurrent cleanup). Surface it rather than guessing.
        RAISE EXCEPTION 'upsert_content_item: insert conflicted for (%, %, %) but no matching row found',
          TRIM(p_title), TRIM(p_author), v_kind;
      END IF;
    END IF;
  END IF;

  IF NOT v_inserted THEN
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
Dedups by (title, author, kind) case-insensitive, race-safely: the create path
inserts with ON CONFLICT on content_items_title_author_kind_uniq and a losing
call attaches to the winner''s row (#207). Returns (content_id, inserted)
where inserted is TRUE only when a brand-new content_items row was created (not
when a source was attached to an existing item) — callers use it to decide
whether a post-insert failure left an orphan they may clean up (#176).
For new content, sets queue_position/position_confirmed/added_by/kind, the
feed-card enrichment fields (image_url, word_count, duration_seconds, #167), and
the book-metadata fields (isbn13, subtitle, series, #186) — all INSERT-only.';

-- Post-#205 grant posture: service_role only (anon/authenticated are locked
-- out of the schema by migration 20260710000000). CREATE OR REPLACE preserved
-- the existing grants; this re-states them explicitly.
GRANT EXECUTE ON FUNCTION upsert_content_item(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, BIGINT, BOOLEAN, TEXT, TEXT, TEXT, TEXT, INT, INT, TEXT, TEXT, TEXT) TO service_role;

-- ============================================================================
-- POST-MIGRATION VERIFICATION
-- ============================================================================

DO $$
DECLARE
  remaining_dups INT;
BEGIN
  SELECT COUNT(*) INTO remaining_dups
  FROM (
    SELECT 1
    FROM content_items
    GROUP BY LOWER(TRIM(title)), LOWER(TRIM(author)), kind
    HAVING COUNT(*) > 1
  ) dups;
  IF remaining_dups > 0 THEN
    RAISE EXCEPTION 'write-integrity migration failed: % duplicate groups remain', remaining_dups;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'content_items_title_author_kind_uniq'
  ) THEN
    RAISE EXCEPTION 'write-integrity migration failed: unique index missing';
  END IF;

  IF NOT has_function_privilege(
    'service_role',
    'public.upsert_content_item(text,text,text,text,timestamptz,text,boolean,bigint,boolean,text,text,text,text,int,int,text,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'write-integrity migration failed: service_role lost EXECUTE on upsert_content_item';
  END IF;

  RAISE NOTICE 'write-integrity migration verified: no duplicate groups, unique index present, service_role EXECUTE intact';
END $$;
