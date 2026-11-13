-- Migration: Add author_engagement_scores view
-- Description: Computes per-author engagement scores using canonical author groupings
-- Date: 2026-02-08
-- Issue: #88 - Content prioritization with engagement scoring
--
-- The view consolidates author aliases via get_author_aliases() and computes:
-- - total: count of all items for this canonical author group
-- - completed: count of items with status 'Completed'
-- - skipped: count of items with status 'Skip'
-- - completion_rate: completed / total
-- - skip_rate: skipped / total
-- - engagement_score: completion_rate - skip_rate (ranges from -1.0 to 1.0)
--
-- Only includes authors with >= 3 total items to avoid noise from one-off authors.

CREATE OR REPLACE VIEW author_engagement_scores AS
WITH author_with_aliases AS (
  -- For each distinct author, find their canonical alias group
  SELECT DISTINCT
    ci.author,
    COALESCE(
      NULLIF(
        (get_author_aliases(ci.author))[1],
        ''
      ),
      LOWER(TRIM(ci.author))
    ) AS canonical_author,
    CASE
      WHEN array_length(get_author_aliases(ci.author), 1) > 0
        THEN get_author_aliases(ci.author)
      ELSE ARRAY[LOWER(TRIM(ci.author))]
    END AS aliases
  FROM content_items ci
  WHERE ci.author IS NOT NULL AND TRIM(ci.author) != ''
),
canonical_groups AS (
  -- Deduplicate to one row per canonical author
  SELECT DISTINCT ON (canonical_author)
    canonical_author,
    aliases
  FROM author_with_aliases
  ORDER BY canonical_author
),
scores AS (
  -- Compute engagement metrics per canonical author
  SELECT
    cg.canonical_author,
    cg.aliases,
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE ci.status = 'Completed')::int AS completed,
    COUNT(*) FILTER (WHERE ci.status = 'Skip')::int AS skipped,
    ROUND(
      COUNT(*) FILTER (WHERE ci.status = 'Completed')::numeric / COUNT(*),
      2
    ) AS completion_rate,
    ROUND(
      COUNT(*) FILTER (WHERE ci.status = 'Skip')::numeric / COUNT(*),
      2
    ) AS skip_rate,
    ROUND(
      (COUNT(*) FILTER (WHERE ci.status = 'Completed')::numeric
       - COUNT(*) FILTER (WHERE ci.status = 'Skip')::numeric)
      / COUNT(*),
      2
    ) AS engagement_score
  FROM canonical_groups cg
  JOIN content_items ci
    ON LOWER(TRIM(ci.author)) = ANY(cg.aliases)
  GROUP BY cg.canonical_author, cg.aliases
)
SELECT *
FROM scores
WHERE total >= 3
ORDER BY engagement_score DESC;

COMMENT ON VIEW author_engagement_scores IS
'Aggregated engagement scores per canonical author group.

Uses get_author_aliases() to consolidate author variants into canonical groups,
then computes completion and skip rates. engagement_score = completion_rate - skip_rate.

Only includes authors with >= 3 total items.
Used by the content prioritization system to rank new incoming content.';
