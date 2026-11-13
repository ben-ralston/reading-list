-- Migration: Merge Duplicate Content Items
-- Description: Combines duplicate content_items (same title+author) by moving sources to primary item
-- Date: 2025-11-23
--
-- Strategy:
--   1. For each group of duplicates, keep the item with the "best" status (Completed > In Progress > Skip > empty)
--   2. If statuses are equal, keep the lowest ID (oldest entry)
--   3. Move all sources from duplicates to the kept item
--   4. Delete the duplicate content_items

-- ============================================================================
-- PRE-MIGRATION: Show duplicates that will be merged
-- ============================================================================

DO $$
DECLARE
  dup_count INT;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT LOWER(TRIM(title)), LOWER(TRIM(author))
    FROM content_items
    GROUP BY LOWER(TRIM(title)), LOWER(TRIM(author))
    HAVING COUNT(*) > 1
  ) dups;

  RAISE NOTICE 'Found % duplicate groups to merge', dup_count;
END $$;

-- Show what will be merged (for verification)
SELECT
  LOWER(TRIM(title)) as normalized_title,
  LOWER(TRIM(author)) as normalized_author,
  COUNT(*) as duplicate_count,
  array_agg(id ORDER BY id) as ids,
  array_agg(status ORDER BY id) as statuses
FROM content_items
GROUP BY LOWER(TRIM(title)), LOWER(TRIM(author))
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC;

-- ============================================================================
-- MERGE DUPLICATES
-- ============================================================================

DO $$
DECLARE
  dup_group RECORD;
  keep_id BIGINT;
  dup_id BIGINT;
  dup_ids BIGINT[];
  source_count INT;
  merged_count INT := 0;
  sources_moved INT := 0;
  items_deleted INT := 0;
BEGIN
  -- Loop through each group of duplicates
  FOR dup_group IN
    SELECT
      LOWER(TRIM(title)) as norm_title,
      LOWER(TRIM(author)) as norm_author,
      array_agg(id ORDER BY
        -- Priority: Completed > In Progress > Skip > empty
        CASE status
          WHEN 'Completed' THEN 1
          WHEN 'In Progress' THEN 2
          WHEN 'Skip' THEN 3
          ELSE 4
        END,
        id  -- Then by lowest ID (oldest)
      ) as ids,
      array_agg(status ORDER BY
        CASE status
          WHEN 'Completed' THEN 1
          WHEN 'In Progress' THEN 2
          WHEN 'Skip' THEN 3
          ELSE 4
        END,
        id
      ) as statuses
    FROM content_items
    GROUP BY LOWER(TRIM(title)), LOWER(TRIM(author))
    HAVING COUNT(*) > 1
  LOOP
    -- First item in array is the one to keep (best status, then lowest ID)
    keep_id := dup_group.ids[1];
    dup_ids := dup_group.ids[2:array_length(dup_group.ids, 1)];

    RAISE NOTICE 'Merging: "%" by "%" - Keeping ID %, removing IDs %',
      dup_group.norm_title, dup_group.norm_author, keep_id, dup_ids;

    -- For each duplicate, move its sources to the kept item
    FOREACH dup_id IN ARRAY dup_ids
    LOOP
      -- Update sources to point to kept item
      -- Use ON CONFLICT to handle cases where the source already exists on the kept item
      UPDATE content_sources
      SET content_item_id = keep_id,
          is_primary = FALSE  -- Only the kept item's sources remain primary
      WHERE content_item_id = dup_id
        AND NOT EXISTS (
          -- Don't move if exact same platform+link already exists on kept item
          SELECT 1 FROM content_sources cs2
          WHERE cs2.content_item_id = keep_id
            AND cs2.platform = content_sources.platform
            AND cs2.link = content_sources.link
        );

      GET DIAGNOSTICS source_count = ROW_COUNT;
      sources_moved := sources_moved + source_count;

      IF source_count > 0 THEN
        RAISE NOTICE '  Moved % source(s) from ID % to ID %', source_count, dup_id, keep_id;
      END IF;

      -- Delete any remaining sources on the duplicate (these were duplicates)
      DELETE FROM content_sources WHERE content_item_id = dup_id;

      -- Delete the duplicate content_item
      DELETE FROM content_items WHERE id = dup_id;
      items_deleted := items_deleted + 1;
    END LOOP;

    merged_count := merged_count + 1;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== MERGE COMPLETE ===';
  RAISE NOTICE 'Duplicate groups merged: %', merged_count;
  RAISE NOTICE 'Sources moved: %', sources_moved;
  RAISE NOTICE 'Duplicate items deleted: %', items_deleted;
END $$;

-- ============================================================================
-- POST-MIGRATION VERIFICATION
-- ============================================================================

-- Verify no duplicates remain
DO $$
DECLARE
  remaining_dups INT;
BEGIN
  SELECT COUNT(*) INTO remaining_dups
  FROM (
    SELECT LOWER(TRIM(title)), LOWER(TRIM(author))
    FROM content_items
    GROUP BY LOWER(TRIM(title)), LOWER(TRIM(author))
    HAVING COUNT(*) > 1
  ) dups;

  IF remaining_dups > 0 THEN
    RAISE WARNING 'Still have % duplicate groups remaining!', remaining_dups;
  ELSE
    RAISE NOTICE 'SUCCESS: No duplicate groups remain';
  END IF;
END $$;

-- Show items that now have multiple sources (the result of merging)
SELECT
  ci.id,
  ci.title,
  ci.author,
  ci.status,
  COUNT(cs.id) as source_count,
  array_agg(cs.platform ORDER BY cs.is_primary DESC, cs.id) as platforms,
  array_agg(cs.is_primary ORDER BY cs.is_primary DESC, cs.id) as is_primary_flags
FROM content_items ci
JOIN content_sources cs ON ci.id = cs.content_item_id
GROUP BY ci.id, ci.title, ci.author, ci.status
HAVING COUNT(cs.id) > 1
ORDER BY source_count DESC, ci.id;

-- Final counts
SELECT
  (SELECT COUNT(*) FROM content_items) as total_content_items,
  (SELECT COUNT(*) FROM content_sources) as total_content_sources,
  (SELECT COUNT(*) FROM content_sources WHERE is_primary = TRUE) as primary_sources,
  (SELECT COUNT(*) FROM content_sources WHERE is_primary = FALSE) as alternate_sources;
