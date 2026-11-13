-- Migration: Fix get_author_aliases multidimensional array error
-- Description: Rewrite function to avoid 2D array with inconsistent dimensions
-- Date: 2026-01-08
-- Issue: #69 - insert_or_update_content RPC fails due to multidimensional array mismatch
--
-- Problem:
-- Migration 20260107000000 accidentally reintroduced a bug that was fixed in 20260103000001.
-- PostgreSQL 2D arrays require all sub-arrays to have identical lengths.
-- The current code uses arrays with 2-3 elements mixed, causing:
-- "multidimensional arrays must have array expressions with matching dimensions"
--
-- Solution:
-- Rewrite get_author_aliases() using IF statements instead of 2D array literal,
-- matching the approach from 20260103000001 but including all current alias groups.

CREATE OR REPLACE FUNCTION get_author_aliases(p_author TEXT)
RETURNS TEXT[]
LANGUAGE plpgsql
IMMUTABLE
AS $func$
DECLARE
  v_normalized TEXT := LOWER(TRIM(p_author));
BEGIN
  -- Check each alias group and return if author matches
  -- Using IF statements to avoid 2D array dimension mismatch issues

  -- Zvi Mowshowitz / Don't Worry About the Vase
  IF v_normalized IN ('zvi mowshowitz', 'don''t worry about the vase', 'don''t worry about the vase podcast') THEN
    RETURN ARRAY['zvi mowshowitz', 'don''t worry about the vase', 'don''t worry about the vase podcast'];
  END IF;

  -- Scott Alexander / Astral Codex Ten
  IF v_normalized IN ('scott alexander', 'astral codex ten') THEN
    RETURN ARRAY['scott alexander', 'astral codex ten'];
  END IF;

  -- Dwarkesh Patel / Dwarkesh Podcast
  IF v_normalized IN ('dwarkesh patel', 'dwarkesh', 'dwarkesh podcast') THEN
    RETURN ARRAY['dwarkesh patel', 'dwarkesh', 'dwarkesh podcast'];
  END IF;

  -- 80,000 Hours
  IF v_normalized IN ('80,000 hours', '80,000 hours podcast', '80000 hours') THEN
    RETURN ARRAY['80,000 hours', '80,000 hours podcast', '80000 hours'];
  END IF;

  -- Ezra Klein Show
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

  -- Redwood Research
  IF v_normalized IN ('redwood research', 'redwood research blog') THEN
    RETURN ARRAY['redwood research', 'redwood research blog'];
  END IF;

  -- No aliases found
  RETURN ARRAY[]::TEXT[];
END;
$func$;

COMMENT ON FUNCTION get_author_aliases(TEXT) IS
'Returns all known aliases for an author name. Used to match content across
different naming conventions (e.g., author name vs podcast name).

Alias groups:
- Zvi Mowshowitz / Don''t Worry About the Vase
- Scott Alexander / Astral Codex Ten
- Dwarkesh Patel / Dwarkesh Podcast
- 80,000 Hours / 80,000 Hours Podcast
- Ezra Klein Show / The Ezra Klein
- This American Life / TAL Partners
- The Cognitive Revolution (various formats)
- Epoch AI / Gradient Updates
- Redwood Research / Redwood Research Blog';
