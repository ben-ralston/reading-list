-- Migration: remove_content_items — delete items and close their queue gaps (#305)
-- Description: Following "This American Life Partners" on Spotify dumped ~220
--   decades-old episodes into the queue. Cleaning them up means deleting many
--   positioned rows at once, and the remaining queue must not be left with the
--   holes they occupied. This RPC does both in one transaction:
--     1. deletes the items' content_sources rows (non-cascading FK) and then
--        the items (feedback cascades);
--     2. shifts every surviving row of the same kind that sat below a removed
--        position up by the number of removed positions above it, preserving
--        order. Gaps that already existed elsewhere in the queue are untouched.
--   Optional p_expected_updated_at (parallel to p_ids) makes the delete
--   conditional: a row whose updated_at changed since the caller selected it
--   (sync recorded progress, user queued it) is skipped, not deleted.
--   It moves more than one content_items row, so it takes the shared
--   content_items:multirow advisory lock FIRST, like every other multi-row
--   writer (#337, migration 20260919000000). The #229 deferred trigger still
--   checks the final state for duplicate positions at commit.
-- Date: 2026-09-28

BEGIN;

CREATE OR REPLACE FUNCTION public.remove_content_items(
  p_ids bigint[],
  p_expected_updated_at timestamptz[] DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  target_ids bigint[];
  gap_kinds text[];
  gap_positions integer[];
  removed_count integer;
BEGIN
  -- #337: serialize with every other multi-row content_items writer BEFORE
  -- taking any row lock. Released automatically at commit/rollback.
  PERFORM pg_advisory_xact_lock(hashtext('content_items:multirow'));

  IF p_expected_updated_at IS NOT NULL
     AND cardinality(p_expected_updated_at) IS DISTINCT FROM cardinality(p_ids) THEN
    RAISE EXCEPTION 'remove_content_items: % ids but % expected timestamps',
      cardinality(p_ids), cardinality(p_expected_updated_at);
  END IF;

  -- Lock the candidates, then keep only rows unchanged since the caller read
  -- them (p_expected_updated_at, parallel to p_ids): a row a sync or the user
  -- touched in between has a newer updated_at and is left alone. Remember the
  -- positions the removed rows free up.
  PERFORM 1 FROM content_items WHERE id = ANY(p_ids) ORDER BY id FOR UPDATE;

  SELECT COALESCE(array_agg(c.id), '{}'),
         COALESCE(array_agg(c.kind) FILTER (WHERE c.queue_position IS NOT NULL), '{}'),
         COALESCE(array_agg(c.queue_position) FILTER (WHERE c.queue_position IS NOT NULL), '{}')
    INTO target_ids, gap_kinds, gap_positions
  FROM content_items c
  WHERE c.id = ANY(p_ids)
    AND (p_expected_updated_at IS NULL OR EXISTS (
      SELECT 1 FROM unnest(p_ids, p_expected_updated_at) AS expected(id, updated_at)
      WHERE expected.id = c.id AND expected.updated_at = c.updated_at
    ));

  DELETE FROM content_sources WHERE content_item_id = ANY(target_ids);
  DELETE FROM content_items WHERE id = ANY(target_ids);
  GET DIAGNOSTICS removed_count = ROW_COUNT;

  -- Close the gaps: each survivor moves up by the number of removed positions
  -- of its kind that sat above it.
  UPDATE content_items ci
  SET queue_position = ci.queue_position - shift.n
  FROM (
    SELECT c.id, count(*)::integer AS n
    FROM content_items c
    JOIN unnest(gap_kinds, gap_positions) AS gap(kind, pos)
      ON gap.kind = c.kind AND gap.pos < c.queue_position
    GROUP BY c.id
  ) shift
  WHERE ci.id = shift.id;

  RETURN removed_count;
END;
$$;

COMMENT ON FUNCTION public.remove_content_items(bigint[], timestamptz[]) IS
'Delete content items (sources first) and close the queue gaps they leave, in
one transaction behind the content_items:multirow advisory lock (#305, #337).
Rows whose updated_at no longer matches p_expected_updated_at (when given)
are skipped. Returns the number of items deleted. Used by the Spotify back-catalog cleanup
(scripts/spotify-backcatalog-cleanup.ts).';

REVOKE ALL ON FUNCTION public.remove_content_items(bigint[], timestamptz[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remove_content_items(bigint[], timestamptz[]) TO service_role;

COMMIT;
