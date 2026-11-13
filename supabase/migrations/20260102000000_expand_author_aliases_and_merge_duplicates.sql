-- Migration: Expand author aliases and merge existing duplicates
-- Description: Add more author alias groups and preserve older published_on dates when deduplicating
-- Date: 2026-01-02
-- Issue: #52 - Deduplication logic misses cases where dates don't match
--
-- Changes:
-- 1. Expand get_author_aliases() with new alias groups
-- 2. Update insert_or_update_content() to preserve older published_on dates
-- 3. Merge 14 existing duplicate pairs in the database

-- ============================================================================
-- STEP 1: Expand author aliases
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
    -- New aliases based on duplicate analysis
    ARRAY['scott alexander', 'astral codex ten'],
    ARRAY['dwarkesh patel', 'dwarkesh', 'dwarkesh podcast'],
    ARRAY['80,000 hours', '80,000 hours podcast', '80000 hours'],
    ARRAY['ezra klein show', 'the ezra klein', 'ezra klein'],
    ARRAY['this american life', 'this american life partners', 'this american life partners (🔓)'],
    ARRAY['the cognitive revolution', '"the cognitive revolution" | ai builders, researchers, and live player analysis'],
    ARRAY['epoch ai', 'gradient updates']
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
- Epoch AI / Gradient Updates';

-- ============================================================================
-- STEP 2: Update insert_or_update_content to preserve older dates
-- ============================================================================

-- Drop all old function signatures to avoid overloading
DROP FUNCTION IF EXISTS insert_or_update_content(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS insert_or_update_content(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, BIGINT, BOOLEAN);
DROP FUNCTION IF EXISTS insert_or_update_content(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, BIGINT, BOOLEAN, TEXT);
DROP FUNCTION IF EXISTS insert_or_update_content(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, BIGINT, BOOLEAN, TEXT, TEXT);

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
  p_added_by TEXT DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_content_id BIGINT;
  v_source_exists BOOLEAN;
  v_has_primary BOOLEAN;
  v_final_is_primary BOOLEAN;
  v_is_new_content BOOLEAN := FALSE;
  v_suffix TEXT;
  v_alias TEXT;
  v_suffixes TEXT[] := ARRAY[
    ' Podcast',
    ' The Podcast',
    ' - The Podcast',
    ' Show',
    ' The Show',
    ' - The Show',
    ' Audio'
  ];
  v_aliases TEXT[];
BEGIN
  -- Validate required parameters
  IF p_title IS NULL OR TRIM(p_title) = '' THEN
    RAISE EXCEPTION 'Title is required';
  END IF;
  IF p_author IS NULL OR TRIM(p_author) = '' THEN
    RAISE EXCEPTION 'Author is required';
  END IF;
  IF p_platform IS NULL OR TRIM(p_platform) = '' THEN
    RAISE EXCEPTION 'Platform is required';
  END IF;
  IF p_link IS NULL OR TRIM(p_link) = '' THEN
    RAISE EXCEPTION 'Link is required';
  END IF;

  -- Strategy 1: Check if content already exists (exact case-insensitive match on title + author)
  SELECT id INTO v_content_id
  FROM content_items
  WHERE LOWER(TRIM(title)) = LOWER(TRIM(p_title))
    AND LOWER(TRIM(author)) = LOWER(TRIM(p_author))
  LIMIT 1;

  -- Strategy 2: If no exact match, try with common author suffixes appended
  -- This handles normalized names like "Dwarkesh" matching "Dwarkesh Podcast"
  IF v_content_id IS NULL THEN
    FOREACH v_suffix IN ARRAY v_suffixes
    LOOP
      SELECT id INTO v_content_id
      FROM content_items
      WHERE LOWER(TRIM(title)) = LOWER(TRIM(p_title))
        AND LOWER(TRIM(author)) = LOWER(TRIM(p_author) || v_suffix)
      LIMIT 1;

      EXIT WHEN v_content_id IS NOT NULL;
    END LOOP;
  END IF;

  -- Strategy 3: If still no match, try author aliases
  -- This handles cases like "Zvi Mowshowitz" = "Don't Worry About the Vase"
  IF v_content_id IS NULL THEN
    v_aliases := get_author_aliases(p_author);
    IF array_length(v_aliases, 1) > 0 THEN
      SELECT id INTO v_content_id
      FROM content_items
      WHERE LOWER(TRIM(title)) = LOWER(TRIM(p_title))
        AND LOWER(TRIM(author)) = ANY(v_aliases)
      LIMIT 1;
    END IF;
  END IF;

  -- If content doesn't exist, create it
  IF v_content_id IS NULL THEN
    v_is_new_content := TRUE;

    INSERT INTO content_items (
      title,
      author,
      published_on,
      queue_position,
      position_confirmed,
      added_by
    )
    VALUES (
      TRIM(p_title),
      TRIM(p_author),
      p_published_on,
      p_queue_position,
      p_position_confirmed,
      p_added_by
    )
    RETURNING id INTO v_content_id;

    -- First source for new content is always primary
    v_final_is_primary := TRUE;
  ELSE
    -- Content exists - preserve older published_on date if provided date is earlier
    IF p_published_on IS NOT NULL THEN
      UPDATE content_items
      SET published_on = p_published_on
      WHERE id = v_content_id
        AND (published_on IS NULL OR p_published_on < published_on);
    END IF;

    -- Check if this specific source already exists
    SELECT EXISTS(
      SELECT 1 FROM content_sources
      WHERE content_item_id = v_content_id
        AND platform = p_platform
        AND link = p_link
    ) INTO v_source_exists;

    -- If source already exists, just return the content_id
    IF v_source_exists THEN
      RETURN v_content_id;
    END IF;

    -- Check if content already has a primary source
    SELECT EXISTS(
      SELECT 1 FROM content_sources
      WHERE content_item_id = v_content_id
        AND is_primary = TRUE
    ) INTO v_has_primary;

    -- Determine if this new source should be primary
    IF p_is_primary THEN
      -- User explicitly requested primary
      v_final_is_primary := TRUE;

      -- Clear existing primary flags if setting new primary
      UPDATE content_sources
      SET is_primary = FALSE
      WHERE content_item_id = v_content_id;
    ELSIF NOT v_has_primary THEN
      -- No primary set yet, use platform priority algorithm
      -- Priority: Spotify > YouTube > Podcast > others
      v_final_is_primary := CASE
        WHEN p_platform = 'Spotify' THEN TRUE
        WHEN p_platform = 'YouTube' THEN TRUE
        WHEN p_platform = 'Podcast' THEN TRUE
        ELSE FALSE
      END;
    ELSE
      -- Has primary, don't override unless explicitly requested
      v_final_is_primary := FALSE;
    END IF;
  END IF;

  -- Insert the new source
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
    p_link,
    p_message_id,
    v_final_is_primary,
    p_external_id
  );

  RETURN v_content_id;
END;
$$;

COMMENT ON FUNCTION insert_or_update_content(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, BIGINT, BOOLEAN, TEXT, TEXT) IS
'Insert or update content with deduplication and multi-source support.

Matching strategy (in order):
1. Exact title + author match (case-insensitive)
2. Title + author with common suffixes (" Podcast", " Show", etc.)
3. Title + author aliases (e.g., "Zvi Mowshowitz" = "Don''t Worry About the Vase")

NEW: When matching existing content, preserves the OLDER published_on date.

For new content, sets queue_position and position_confirmed if provided.
For existing content, only adds a new source.
Returns the content_item ID.

Parameters:
- p_title, p_author: Required content identification
- p_platform, p_link: Required source information
- p_published_on: Optional publication date (older date is preserved when deduping)
- p_message_id: Optional email message ID for deduplication
- p_is_primary: Force this source as primary (default false)
- p_queue_position: Queue position (only set for NEW content)
- p_position_confirmed: Whether position is confirmed (only set for NEW content)
- p_external_id: Optional external ID (e.g., spotify:episode:xxx)
- p_added_by: Optional source identifier (e.g., spotify, tasklet)';

-- Grant permissions
GRANT EXECUTE ON FUNCTION insert_or_update_content(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, BIGINT, BOOLEAN, TEXT, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION insert_or_update_content(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, BIGINT, BOOLEAN, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION insert_or_update_content(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, BIGINT, BOOLEAN, TEXT, TEXT) TO service_role;

-- ============================================================================
-- STEP 3: Merge existing duplicates (one-time data migration)
-- ============================================================================

-- Pre-migration: Show what will be merged
DO $$
DECLARE
  dup_count INT := 0;
BEGIN
  RAISE NOTICE '=== PRE-MIGRATION: Duplicate pairs to merge ===';
END $$;

-- Merge function to handle a single duplicate pair
-- Parameters: keep_id (item to keep), delete_id (item to delete)
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

  -- All duplicate pairs from analysis
  -- Format: ARRAY[keep_id, delete_id]
  v_pairs BIGINT[][] := ARRAY[
    ARRAY[394, 499],   -- 255: Our Holiday Gift-Giving Guide (This American Life)
    ARRAY[121, 508],   -- 871: The Thing About Things (This American Life)
    ARRAY[323, 564],   -- Best Of: Zadie Smith... (Ezra Klein Show) - keep 323 per user decision
    ARRAY[455, 456],   -- Dating Roundup #9... (DWATV/Zvi)
    ARRAY[131, 322],   -- Extreme power concentration (80,000 Hours)
    ARRAY[290, 193],   -- In What Sense Is Life Suffering? - keep Astral Codex Ten (290), delete Scott Alexander (193)
    ARRAY[559, 377],   -- Recent LLMs can use filler tokens... - keep 559 per user decision (In Progress, not Completed)
    ARRAY[162, 505],   -- Sarah Paine... (Dwarkesh Patel)
    ARRAY[308, 503],   -- Sovereign AI in Poland... (Cognitive Revolution)
    ARRAY[292, 217],   -- Suggest Questions For Metaculus... - keep Astral Codex Ten (292), delete Scott Alexander (217)
    ARRAY[289, 184],   -- The Bloomer's Paradox - keep Astral Codex Ten (289), delete Scott Alexander (184)
    ARRAY[293, 242],   -- The New AI Consciousness Paper - keep Astral Codex Ten (293), delete Scott Alexander (242)
    ARRAY[291, 202],   -- What Happened To SF Homelessness? - keep Astral Codex Ten (291), delete Scott Alexander (202)
    ARRAY[381, 538]    -- Why benchmarking is hard (Epoch AI)
  ];
  v_pair BIGINT[];
BEGIN
  FOREACH v_pair SLICE 1 IN ARRAY v_pairs
  LOOP
    v_keep_id := v_pair[1];
    v_delete_id := v_pair[2];

    -- Check both items exist
    IF NOT EXISTS (SELECT 1 FROM content_items WHERE id = v_keep_id) THEN
      RAISE NOTICE 'Skipping: Keep ID % does not exist', v_keep_id;
      CONTINUE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM content_items WHERE id = v_delete_id) THEN
      RAISE NOTICE 'Skipping: Delete ID % does not exist', v_delete_id;
      CONTINUE;
    END IF;

    -- Get published dates and statuses
    SELECT published_on, status INTO v_keep_published, v_keep_status FROM content_items WHERE id = v_keep_id;
    SELECT published_on, status INTO v_delete_published, v_delete_status FROM content_items WHERE id = v_delete_id;

    -- Determine older date and update if needed
    IF v_delete_published IS NOT NULL AND (v_keep_published IS NULL OR v_delete_published < v_keep_published) THEN
      v_older_date := v_delete_published;
      UPDATE content_items SET published_on = v_older_date WHERE id = v_keep_id;
      RAISE NOTICE 'Updated published_on for ID % from % to %', v_keep_id, v_keep_published, v_older_date;
    END IF;

    -- Determine better status (priority: Completed > In Progress > Skip > empty)
    -- Special case: pair 559/377 - user wants to keep "In Progress" (don't upgrade to Completed)
    IF v_keep_id = 559 AND v_delete_id = 377 THEN
      v_better_status := v_keep_status;  -- Keep original status for this specific pair
      RAISE NOTICE 'Keeping original status "%" for ID 559 per user request', v_keep_status;
    ELSE
      -- Standard logic: preserve best non-empty status from either item
      v_better_status := CASE
        WHEN v_keep_status = 'Completed' OR v_delete_status = 'Completed' THEN 'Completed'
        WHEN v_keep_status = 'In Progress' OR v_delete_status = 'In Progress' THEN 'In Progress'
        WHEN v_keep_status = 'Skip' OR v_delete_status = 'Skip' THEN 'Skip'
        ELSE v_keep_status  -- Keep original if both empty
      END;

      -- Update status if the delete_id had a better status
      -- Per schema constraint: Completed/Skip items must have queue_position = NULL
      IF v_better_status IS DISTINCT FROM v_keep_status THEN
        IF v_better_status IN ('Completed', 'Skip') THEN
          UPDATE content_items
          SET status = v_better_status, queue_position = NULL, position_confirmed = FALSE
          WHERE id = v_keep_id;
          RAISE NOTICE 'Updated status for ID % from "%" to "%" (cleared queue_position per constraint)', v_keep_id, v_keep_status, v_better_status;
        ELSE
          UPDATE content_items SET status = v_better_status WHERE id = v_keep_id;
          RAISE NOTICE 'Updated status for ID % from "%" to "%"', v_keep_id, v_keep_status, v_better_status;
        END IF;
      END IF;
    END IF;

    -- Move sources from delete_id to keep_id (if not already present)
    UPDATE content_sources
    SET content_item_id = v_keep_id,
        is_primary = FALSE  -- Don't override existing primary
    WHERE content_item_id = v_delete_id
      AND NOT EXISTS (
        -- Don't move if exact same platform+link already exists on kept item
        SELECT 1 FROM content_sources cs2
        WHERE cs2.content_item_id = v_keep_id
          AND cs2.platform = content_sources.platform
          AND cs2.link = content_sources.link
      );

    GET DIAGNOSTICS v_source_count = ROW_COUNT;
    IF v_source_count > 0 THEN
      RAISE NOTICE 'Moved % source(s) from ID % to ID %', v_source_count, v_delete_id, v_keep_id;
    END IF;

    -- Delete any remaining sources on the duplicate (these were duplicates)
    DELETE FROM content_sources WHERE content_item_id = v_delete_id;

    -- Delete the duplicate content_item
    DELETE FROM content_items WHERE id = v_delete_id;

    v_merged_count := v_merged_count + 1;
    RAISE NOTICE 'Merged: Deleted ID %, kept ID %', v_delete_id, v_keep_id;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== MERGE COMPLETE ===';
  RAISE NOTICE 'Total pairs merged: %', v_merged_count;
END $$;

-- ============================================================================
-- STEP 4: Verification
-- ============================================================================

-- Verify no duplicates remain (by exact title match)
DO $$
DECLARE
  remaining_dups INT;
BEGIN
  SELECT COUNT(*) INTO remaining_dups
  FROM (
    SELECT LOWER(TRIM(title))
    FROM content_items
    GROUP BY LOWER(TRIM(title))
    HAVING COUNT(*) > 1
  ) dups;

  IF remaining_dups > 0 THEN
    RAISE NOTICE 'NOTE: % title groups still have multiple items (may have different authors)', remaining_dups;
  ELSE
    RAISE NOTICE 'SUCCESS: No duplicate title groups remain';
  END IF;
END $$;

-- Show items that now have multiple sources (result of merging)
DO $$
DECLARE
  v_multi_source_count INT;
  v_total_items INT;
  v_total_sources INT;
  v_rec RECORD;
BEGIN
  -- Count multi-source items
  SELECT COUNT(*) INTO v_multi_source_count
  FROM (
    SELECT ci.id
    FROM content_items ci
    JOIN content_sources cs ON ci.id = cs.content_item_id
    GROUP BY ci.id
    HAVING COUNT(cs.id) > 1
  ) multi;

  RAISE NOTICE 'Items with multiple sources: %', v_multi_source_count;

  -- Show top 5 multi-source items
  FOR v_rec IN
    SELECT
      ci.id,
      LEFT(ci.title, 50) as title,
      COUNT(cs.id) as source_count
    FROM content_items ci
    JOIN content_sources cs ON ci.id = cs.content_item_id
    GROUP BY ci.id, ci.title
    HAVING COUNT(cs.id) > 1
    ORDER BY COUNT(cs.id) DESC
    LIMIT 5
  LOOP
    RAISE NOTICE '  ID %: % (% sources)', v_rec.id, v_rec.title, v_rec.source_count;
  END LOOP;

  -- Final counts
  SELECT COUNT(*) INTO v_total_items FROM content_items;
  SELECT COUNT(*) INTO v_total_sources FROM content_sources;

  RAISE NOTICE '';
  RAISE NOTICE '=== FINAL COUNTS ===';
  RAISE NOTICE 'Total content items: %', v_total_items;
  RAISE NOTICE 'Total content sources: %', v_total_sources;
END $$;
