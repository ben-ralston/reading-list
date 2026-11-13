-- Migration: Add Redwood Research author alias
-- Description: Add alias group for Redwood Research / Redwood Research Blog
-- Date: 2026-01-07
-- Issue: #61 - Redwood Research duplicate entries due to author name mismatch
--
-- Problem:
-- - Substack: author = "Redwood Research"
-- - Spotify: author = "Redwood Research Blog"
-- These should match as the same author for deduplication.

-- ============================================================================
-- STEP 1: Update get_author_aliases with new alias group
-- ============================================================================

CREATE OR REPLACE FUNCTION get_author_aliases(p_author TEXT)
RETURNS TEXT[]
LANGUAGE plpgsql
IMMUTABLE
AS $func$
DECLARE
  v_normalized TEXT := LOWER(TRIM(p_author));
  -- Define alias groups - authors in the same group are considered equivalent
  v_alias_groups TEXT[][] := ARRAY[
    -- Existing aliases
    ARRAY['zvi mowshowitz', 'don''t worry about the vase', 'don''t worry about the vase podcast'],
    ARRAY['scott alexander', 'astral codex ten'],
    ARRAY['dwarkesh patel', 'dwarkesh', 'dwarkesh podcast'],
    ARRAY['80,000 hours', '80,000 hours podcast', '80000 hours'],
    ARRAY['ezra klein show', 'the ezra klein', 'ezra klein'],
    ARRAY['this american life', 'this american life partners', 'this american life partners (🔓)'],
    ARRAY['the cognitive revolution', '"the cognitive revolution" | ai builders, researchers, and live player analysis'],
    ARRAY['epoch ai', 'gradient updates'],
    -- New alias for #61
    ARRAY['redwood research', 'redwood research blog']
  ];
  v_group TEXT[];
  v_alias TEXT;
BEGIN
  -- Check each alias group
  FOREACH v_group SLICE 1 IN ARRAY v_alias_groups
  LOOP
    -- If the author is in this group, return all aliases
    FOREACH v_alias IN ARRAY v_group
    LOOP
      IF v_normalized = v_alias THEN
        RETURN v_group;
      END IF;
    END LOOP;
  END LOOP;

  -- No aliases found, return empty array
  RETURN ARRAY[]::TEXT[];
END;
$func$;

COMMENT ON FUNCTION get_author_aliases(TEXT) IS
'Returns all known aliases for an author name. Used to match content across
different naming conventions (e.g., author name vs podcast name).

Alias groups:
- Zvi Mowshowitz / Don''t Worry About the Vase
- Scott Alexander / Astral Codex Ten
- Dwarkesh Patel / Dwarkesh
- 80,000 Hours / 80,000 Hours Podcast
- Ezra Klein Show / The Ezra Klein
- This American Life / TAL Partners
- The Cognitive Revolution (various formats)
- Epoch AI / Gradient Updates
- Redwood Research / Redwood Research Blog';

-- ============================================================================
-- STEP 2: Find and merge any existing Redwood Research duplicates
-- ============================================================================

DO $$
DECLARE
  v_keep_id BIGINT;
  v_delete_id BIGINT;
  v_keep_published TIMESTAMPTZ;
  v_delete_published TIMESTAMPTZ;
  v_keep_status TEXT;
  v_delete_status TEXT;
  v_better_status TEXT;
  v_older_date TIMESTAMPTZ;
  v_source_count INT;
  v_merged_count INT := 0;
  v_rec RECORD;
BEGIN
  RAISE NOTICE '=== Checking for Redwood Research duplicates ===';

  -- Find duplicate pairs: same title, one author is "Redwood Research", other is "Redwood Research Blog"
  FOR v_rec IN
    SELECT
      r1.id as keep_id,
      r2.id as delete_id,
      r1.title
    FROM content_items r1
    JOIN content_items r2 ON LOWER(TRIM(r1.title)) = LOWER(TRIM(r2.title))
    WHERE LOWER(TRIM(r1.author)) = 'redwood research'
      AND LOWER(TRIM(r2.author)) = 'redwood research blog'
      AND r1.id != r2.id
  LOOP
    v_keep_id := v_rec.keep_id;
    v_delete_id := v_rec.delete_id;

    RAISE NOTICE 'Found duplicate: "%" (keep ID %, delete ID %)', v_rec.title, v_keep_id, v_delete_id;

    -- Get published dates and statuses
    SELECT published_on, status INTO v_keep_published, v_keep_status FROM content_items WHERE id = v_keep_id;
    SELECT published_on, status INTO v_delete_published, v_delete_status FROM content_items WHERE id = v_delete_id;

    -- Preserve older published_on date
    IF v_delete_published IS NOT NULL AND (v_keep_published IS NULL OR v_delete_published < v_keep_published) THEN
      v_older_date := v_delete_published;
      UPDATE content_items SET published_on = v_older_date WHERE id = v_keep_id;
      RAISE NOTICE '  Updated published_on from % to %', v_keep_published, v_older_date;
    END IF;

    -- Preserve best status (Completed > In Progress > Skip > empty)
    v_better_status := CASE
      WHEN v_keep_status = 'Completed' OR v_delete_status = 'Completed' THEN 'Completed'
      WHEN v_keep_status = 'In Progress' OR v_delete_status = 'In Progress' THEN 'In Progress'
      WHEN v_keep_status = 'Skip' OR v_delete_status = 'Skip' THEN 'Skip'
      ELSE v_keep_status
    END;

    IF v_better_status IS DISTINCT FROM v_keep_status THEN
      IF v_better_status IN ('Completed', 'Skip') THEN
        UPDATE content_items
        SET status = v_better_status, queue_position = NULL, position_confirmed = FALSE
        WHERE id = v_keep_id;
      ELSE
        UPDATE content_items SET status = v_better_status WHERE id = v_keep_id;
      END IF;
      RAISE NOTICE '  Updated status from "%" to "%"', v_keep_status, v_better_status;
    END IF;

    -- Move sources from delete_id to keep_id
    UPDATE content_sources
    SET content_item_id = v_keep_id,
        is_primary = FALSE
    WHERE content_item_id = v_delete_id
      AND NOT EXISTS (
        SELECT 1 FROM content_sources cs2
        WHERE cs2.content_item_id = v_keep_id
          AND cs2.platform = content_sources.platform
          AND cs2.link = content_sources.link
      );

    GET DIAGNOSTICS v_source_count = ROW_COUNT;
    IF v_source_count > 0 THEN
      RAISE NOTICE '  Moved % source(s)', v_source_count;
    END IF;

    -- Delete remaining sources and the duplicate item
    DELETE FROM content_sources WHERE content_item_id = v_delete_id;
    DELETE FROM content_items WHERE id = v_delete_id;

    v_merged_count := v_merged_count + 1;
    RAISE NOTICE '  Merged: deleted ID %, kept ID %', v_delete_id, v_keep_id;
  END LOOP;

  IF v_merged_count = 0 THEN
    RAISE NOTICE 'No existing Redwood Research duplicates found.';
  ELSE
    RAISE NOTICE '';
    RAISE NOTICE '=== MERGE COMPLETE: % pair(s) merged ===', v_merged_count;
  END IF;
END $$;
