-- Migration: Fix sync bugs
-- Date: 2026-01-03
--
-- Fixes two issues:
-- 1. get_author_aliases() uses 2D array with inconsistent dimensions, causing
--    "multidimensional arrays must have array expressions with matching dimensions" error
-- 2. Duplicate Spotify sources exist for some content items, causing
--    "JSON object requested, multiple (or no) rows returned" error
--
-- Solutions:
-- 1. Rewrite get_author_aliases() to avoid 2D array literal
-- 2. Clean up duplicate sources and add unique constraint

-- ============================================================================
-- STEP 1: Fix get_author_aliases function
-- ============================================================================

CREATE OR REPLACE FUNCTION get_author_aliases(p_author TEXT)
RETURNS TEXT[]
LANGUAGE plpgsql
IMMUTABLE
AS $func$
DECLARE
  v_normalized TEXT := LOWER(TRIM(p_author));
BEGIN
  -- Check each alias group and return if author matches
  -- Using CASE to avoid 2D array dimension mismatch issues

  -- Zvi Mowshowitz / Don't Worry About the Vase
  IF v_normalized IN ('zvi mowshowitz', 'don''t worry about the vase', 'don''t worry about the vase podcast') THEN
    RETURN ARRAY['zvi mowshowitz', 'don''t worry about the vase', 'don''t worry about the vase podcast'];
  END IF;

  -- Scott Alexander / Astral Codex Ten
  IF v_normalized IN ('scott alexander', 'astral codex ten') THEN
    RETURN ARRAY['scott alexander', 'astral codex ten'];
  END IF;

  -- Dwarkesh Patel / Dwarkesh
  IF v_normalized IN ('dwarkesh patel', 'dwarkesh', 'dwarkesh podcast') THEN
    RETURN ARRAY['dwarkesh patel', 'dwarkesh', 'dwarkesh podcast'];
  END IF;

  -- 80,000 Hours
  IF v_normalized IN ('80,000 hours', '80,000 hours podcast', '80000 hours') THEN
    RETURN ARRAY['80,000 hours', '80,000 hours podcast', '80000 hours'];
  END IF;

  -- Ezra Klein
  IF v_normalized IN ('ezra klein show', 'the ezra klein', 'ezra klein') THEN
    RETURN ARRAY['ezra klein show', 'the ezra klein', 'ezra klein'];
  END IF;

  -- This American Life
  IF v_normalized IN ('this american life', 'this american life partners', 'this american life partners (🔓)') THEN
    RETURN ARRAY['this american life', 'this american life partners', 'this american life partners (🔓)'];
  END IF;

  -- The Cognitive Revolution
  IF v_normalized IN ('the cognitive revolution', '"the cognitive revolution" | ai builders, researchers, and live player analysis') THEN
    RETURN ARRAY['the cognitive revolution', '"the cognitive revolution" | ai builders, researchers, and live player analysis'];
  END IF;

  -- Epoch AI / Gradient Updates
  IF v_normalized IN ('epoch ai', 'gradient updates') THEN
    RETURN ARRAY['epoch ai', 'gradient updates'];
  END IF;

  -- No aliases found
  RETURN ARRAY[]::TEXT[];
END;
$func$;

-- ============================================================================
-- STEP 2: Clean up duplicate Spotify sources
-- ============================================================================

-- Delete the older duplicate sources (the ones without external_id)
-- Keep the newer ones with proper external_ids
DELETE FROM content_sources
WHERE id IN (
  SELECT cs1.id
  FROM content_sources cs1
  JOIN content_sources cs2
    ON cs1.content_item_id = cs2.content_item_id
    AND cs1.platform = cs2.platform
    AND cs1.id < cs2.id  -- cs1 is older
  WHERE cs1.platform = 'Spotify'
    AND cs1.external_id IS NULL  -- Old one has no external_id
    AND cs2.external_id IS NOT NULL  -- New one has external_id
);

-- ============================================================================
-- STEP 3: Add unique constraint to prevent future duplicates
-- ============================================================================

-- Add unique constraint on (content_item_id, platform) to prevent duplicates
-- Use CREATE UNIQUE INDEX for partial constraint (allows multiple sources per platform
-- only if they have different external_ids)
DO $$
BEGIN
  -- Check if constraint already exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'content_sources_item_platform_unique'
  ) THEN
    -- For now, just add an index rather than a constraint to allow flexibility
    -- The application code should handle deduplication
    CREATE UNIQUE INDEX IF NOT EXISTS content_sources_item_platform_idx
    ON content_sources (content_item_id, platform)
    WHERE external_id IS NOT NULL;
  END IF;
END $$;
