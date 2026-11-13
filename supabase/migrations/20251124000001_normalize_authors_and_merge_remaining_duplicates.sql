-- Migration: Normalize Titles/Authors and Merge Remaining Duplicate Content Items
-- Description: Removes title suffixes, standardizes author names, then merges duplicates
-- Date: 2025-11-24
--
-- Strategy:
--   Phase 1: Pre-migration verification (show current state)
--   Phase 2: Normalize titles (remove "(Podcast)", "(Narration)", "Podcast" suffixes)
--   Phase 3: Normalize author names (11 variations → canonical names)
--   Phase 4: Merge duplicate content items (same title+author after normalization)
--   Phase 5: Post-migration verification (confirm zero duplicates)
--
-- Expected Impact:
--   - Normalize ~10 title suffixes
--   - Normalize ~80 author names across 11 variation patterns
--   - Merge 40+ duplicate content groups
--   - Reduce 249 items → ~195 unique items
--   - Preserve all sources, create ~54 multi-source items

-- ============================================================================
-- PHASE 1: PRE-MIGRATION VERIFICATION
-- ============================================================================

DO $$
DECLARE
  v_items INT;
  v_sources INT;
  v_dups INT;
BEGIN
  -- Show baseline counts
  SELECT COUNT(*) INTO v_items FROM content_items;
  SELECT COUNT(*) INTO v_sources FROM content_sources;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== PRE-MIGRATION STATE ===';
  RAISE NOTICE 'Total content_items: %', v_items;
  RAISE NOTICE 'Total content_sources: %', v_sources;

  -- Count duplicate groups before author normalization
  SELECT COUNT(*) INTO v_dups
  FROM (
    SELECT LOWER(TRIM(title)), LOWER(TRIM(author))
    FROM content_items
    GROUP BY LOWER(TRIM(title)), LOWER(TRIM(author))
    HAVING COUNT(*) > 1
  ) dups;

  RAISE NOTICE 'Duplicate groups (before author normalization): %', v_dups;
  RAISE NOTICE ' ';
END $$;

-- Show author variations that will be normalized
SELECT
  author,
  COUNT(*) as item_count
FROM content_items
WHERE author IN (
  'Zvi',
  'Scott Alexander (ACX Podcast)',
  'Astral Codex Ten',
  'Astral Codex Ten Podcast',
  'LessWrong (Curated & Popular)',
  '80,000 Hours Podcast',
  'Dwarkesh Podcast'
)
OR author LIKE 'Don''t Worry About the Vase%Zvi%'
OR author LIKE 'Don''t Worry About the Vase (LessWrong%'
OR author LIKE 'DWAtV Podcast%'
GROUP BY author
ORDER BY item_count DESC;

-- Show titles with suffixes that will be normalized
SELECT
  title,
  id
FROM content_items
WHERE title ~ ' \(Podcast\)$'
   OR title ~ ' \(Narration\)$'
   OR (title ~ ' Podcast$' AND title NOT LIKE '%%(Podcast)')
ORDER BY title;

-- ============================================================================
-- PHASE 2: TITLE NORMALIZATION
-- ============================================================================

DO $$
DECLARE
  v_count INT;
  v_total_normalized INT := 0;
BEGIN
  RAISE NOTICE ' ';
  RAISE NOTICE '=== PHASE 2: TITLE NORMALIZATION ===';

  -- 1. Remove " (Podcast)" suffix
  UPDATE content_items
  SET title = REGEXP_REPLACE(title, ' \(Podcast\)$', '')
  WHERE title ~ ' \(Podcast\)$';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    RAISE NOTICE 'Normalized % titles: removed " (Podcast)" suffix', v_count;
    v_total_normalized := v_total_normalized + v_count;
  END IF;

  -- 2. Remove " (Narration)" suffix
  UPDATE content_items
  SET title = REGEXP_REPLACE(title, ' \(Narration\)$', '')
  WHERE title ~ ' \(Narration\)$';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    RAISE NOTICE 'Normalized % titles: removed " (Narration)" suffix', v_count;
    v_total_normalized := v_total_normalized + v_count;
  END IF;

  -- 3. Remove " Podcast" suffix (without parentheses)
  UPDATE content_items
  SET title = REGEXP_REPLACE(title, ' Podcast$', '')
  WHERE title ~ ' Podcast$' AND title NOT LIKE '%%(Podcast)';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    RAISE NOTICE 'Normalized % titles: removed " Podcast" suffix', v_count;
    v_total_normalized := v_total_normalized + v_count;
  END IF;

  RAISE NOTICE ' ';
  RAISE NOTICE 'Total titles normalized: %', v_total_normalized;
  RAISE NOTICE ' ';
END $$;

-- ============================================================================
-- PHASE 3: AUTHOR NAME NORMALIZATION
-- ============================================================================

DO $$
DECLARE
  v_count INT;
  v_total_normalized INT := 0;
BEGIN
  RAISE NOTICE ' ';
  RAISE NOTICE '=== PHASE 3: AUTHOR NORMALIZATION ===';

  -- 1. Normalize "Zvi" → "Zvi Mowshowitz"
  UPDATE content_items SET author = 'Zvi Mowshowitz' WHERE author = 'Zvi';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    RAISE NOTICE 'Normalized % items: "Zvi" → "Zvi Mowshowitz"', v_count;
    v_total_normalized := v_total_normalized + v_count;
  END IF;

  -- 2. Normalize "Scott Alexander (ACX Podcast)" → "Scott Alexander"
  UPDATE content_items SET author = 'Scott Alexander' WHERE author = 'Scott Alexander (ACX Podcast)';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    RAISE NOTICE 'Normalized % items: "Scott Alexander (ACX Podcast)" → "Scott Alexander"', v_count;
    v_total_normalized := v_total_normalized + v_count;
  END IF;

  -- 3. Normalize "Astral Codex Ten" → "Scott Alexander"
  UPDATE content_items SET author = 'Scott Alexander' WHERE author = 'Astral Codex Ten';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    RAISE NOTICE 'Normalized % items: "Astral Codex Ten" → "Scott Alexander"', v_count;
    v_total_normalized := v_total_normalized + v_count;
  END IF;

  -- 4. Normalize "Astral Codex Ten Podcast" → "Scott Alexander"
  UPDATE content_items SET author = 'Scott Alexander' WHERE author = 'Astral Codex Ten Podcast';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    RAISE NOTICE 'Normalized % items: "Astral Codex Ten Podcast" → "Scott Alexander"', v_count;
    v_total_normalized := v_total_normalized + v_count;
  END IF;

  -- 5. Normalize "LessWrong (Curated & Popular)" → "LessWrong"
  UPDATE content_items SET author = 'LessWrong' WHERE author = 'LessWrong (Curated & Popular)';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    RAISE NOTICE 'Normalized % items: "LessWrong (Curated & Popular)" → "LessWrong"', v_count;
    v_total_normalized := v_total_normalized + v_count;
  END IF;

  -- 6. Normalize "80,000 Hours Podcast" → "80,000 Hours"
  UPDATE content_items SET author = '80,000 Hours' WHERE author = '80,000 Hours Podcast';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    RAISE NOTICE 'Normalized % items: "80,000 Hours Podcast" → "80,000 Hours"', v_count;
    v_total_normalized := v_total_normalized + v_count;
  END IF;

  -- 7. Normalize "Dwarkesh Podcast" → "Dwarkesh Patel"
  UPDATE content_items SET author = 'Dwarkesh Patel' WHERE author = 'Dwarkesh Podcast';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    RAISE NOTICE 'Normalized % items: "Dwarkesh Podcast" → "Dwarkesh Patel"', v_count;
    v_total_normalized := v_total_normalized + v_count;
  END IF;

  -- 8. Normalize "Don't Worry About the Vase (Zvi)" and variations → "Zvi Mowshowitz"
  UPDATE content_items SET author = 'Zvi Mowshowitz'
  WHERE author LIKE 'Don''t Worry About the Vase%Zvi%';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    RAISE NOTICE 'Normalized % items: "Don''t Worry About the Vase%%Zvi%%" → "Zvi Mowshowitz"', v_count;
    v_total_normalized := v_total_normalized + v_count;
  END IF;

  -- 9. Normalize "Don't Worry About the Vase (LessWrong Podcast)" → "Don't Worry About the Vase"
  UPDATE content_items SET author = 'Don''t Worry About the Vase'
  WHERE author = 'Don''t Worry About the Vase (LessWrong Podcast)';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    RAISE NOTICE 'Normalized % items: "Don''t Worry About the Vase (LessWrong Podcast)" → "Don''t Worry About the Vase"', v_count;
    v_total_normalized := v_total_normalized + v_count;
  END IF;

  -- 10. Normalize "DWAtV Podcast <email>" and variations → "Don't Worry About the Vase"
  UPDATE content_items SET author = 'Don''t Worry About the Vase'
  WHERE author LIKE 'DWAtV Podcast%';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    RAISE NOTICE 'Normalized % items: "DWAtV Podcast%%" → "Don''t Worry About the Vase"', v_count;
    v_total_normalized := v_total_normalized + v_count;
  END IF;

  -- 11. Normalize "Don't Worry About the Vase (LessWrong)" → "Don't Worry About the Vase"
  UPDATE content_items SET author = 'Don''t Worry About the Vase'
  WHERE author = 'Don''t Worry About the Vase (LessWrong)';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    RAISE NOTICE 'Normalized % items: "Don''t Worry About the Vase (LessWrong)" → "Don''t Worry About the Vase"', v_count;
    v_total_normalized := v_total_normalized + v_count;
  END IF;

  RAISE NOTICE ' ';
  RAISE NOTICE 'Total author names normalized: %', v_total_normalized;
  RAISE NOTICE ' ';
END $$;

-- Show duplicate groups after author normalization (will be more than before)
DO $$
DECLARE
  v_dups INT;
BEGIN
  SELECT COUNT(*) INTO v_dups
  FROM (
    SELECT LOWER(TRIM(title)), LOWER(TRIM(author))
    FROM content_items
    GROUP BY LOWER(TRIM(title)), LOWER(TRIM(author))
    HAVING COUNT(*) > 1
  ) dups;

  RAISE NOTICE 'Duplicate groups (after author normalization): %', v_dups;
  RAISE NOTICE ' ';
END $$;

-- ============================================================================
-- PHASE 4: MERGE DUPLICATE CONTENT ITEMS
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
  RAISE NOTICE '=== PHASE 4: MERGING DUPLICATES ===';

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
      -- Use NOT EXISTS to handle cases where the source already exists on the kept item
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

      -- Delete any remaining sources on the duplicate (these were exact duplicates)
      DELETE FROM content_sources WHERE content_item_id = dup_id;

      -- Delete the duplicate content_item
      DELETE FROM content_items WHERE id = dup_id;
      items_deleted := items_deleted + 1;
    END LOOP;

    merged_count := merged_count + 1;
  END LOOP;

  RAISE NOTICE ' ';
  RAISE NOTICE '=== MERGE COMPLETE ===';
  RAISE NOTICE 'Duplicate groups merged: %', merged_count;
  RAISE NOTICE 'Sources moved: %', sources_moved;
  RAISE NOTICE 'Duplicate items deleted: %', items_deleted;
  RAISE NOTICE ' ';
END $$;

-- ============================================================================
-- PHASE 5: POST-MIGRATION VERIFICATION
-- ============================================================================

-- Verify no duplicates remain
DO $$
DECLARE
  remaining_dups INT;
BEGIN
  RAISE NOTICE '=== PHASE 5: POST-MIGRATION VERIFICATION ===';

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

-- Verify author normalization succeeded
DO $$
DECLARE
  v_scott INT;
  v_zvi INT;
  v_lesswrong INT;
  v_80k INT;
  v_dwarkesh INT;
  v_dwatv INT;
BEGIN
  SELECT COUNT(*) INTO v_scott FROM content_items WHERE author = 'Scott Alexander';
  SELECT COUNT(*) INTO v_zvi FROM content_items WHERE author = 'Zvi Mowshowitz';
  SELECT COUNT(*) INTO v_lesswrong FROM content_items WHERE author = 'LessWrong';
  SELECT COUNT(*) INTO v_80k FROM content_items WHERE author = '80,000 Hours';
  SELECT COUNT(*) INTO v_dwarkesh FROM content_items WHERE author = 'Dwarkesh Patel';
  SELECT COUNT(*) INTO v_dwatv FROM content_items WHERE author = 'Don''t Worry About the Vase';

  RAISE NOTICE ' ';
  RAISE NOTICE 'Canonical author counts:';
  RAISE NOTICE '  Scott Alexander: % items', v_scott;
  RAISE NOTICE '  Zvi Mowshowitz: % items', v_zvi;
  RAISE NOTICE '  LessWrong: % items', v_lesswrong;
  RAISE NOTICE '  80,000 Hours: % items', v_80k;
  RAISE NOTICE '  Dwarkesh Patel: % items', v_dwarkesh;
  RAISE NOTICE '  Don''t Worry About the Vase: % items', v_dwatv;
  RAISE NOTICE ' ';
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

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE ' ';
  RAISE NOTICE '=== MIGRATION 20251124000001 COMPLETE ===';
  RAISE NOTICE 'Next steps:';
  RAISE NOTICE '1. Verify final counts match expectations (~195 items, ~238 sources)';
  RAISE NOTICE '2. Check UI displays multi-source items correctly';
  RAISE NOTICE '3. Monitor for 24 hours';
  RAISE NOTICE ' ';
END $$;
