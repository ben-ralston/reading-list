-- Migration: Heal duplicate queue positions and enforce uniqueness (#229)
--
-- Prod accreted FOUR feed items at queue_position 1 (plus gaps): client-side
-- Make Next/reorder batches computed from stale or pruned state promoted a new
-- item to position 1 without renumbering the previous holder, and nothing at
-- the DB layer rejected the duplicate. A client-side sort bug then hid the
-- duplicated items entirely (fixed in lib/queue-client.ts).
--
-- 1) Renumber each kind's queue to unique sequential positions (1..N),
--    preserving current order; ties (the duplicates) broken by In Progress
--    first, then most recently updated. MUST run before the trigger exists.
-- 2) Support index so the per-row commit-time check is an index-only lookup.
-- 3) DEFERRABLE INITIALLY DEFERRED constraint trigger: any transaction whose
--    FINAL state holds duplicate (kind, queue_position) fails with 23505.
--    Deferred (commit-time) checking is what keeps multi-row shifts legal:
--    place_item_in_queue and Make Next renumbers duplicate positions
--    transiently mid-transaction. A plain partial UNIQUE index would reject
--    those mid-statement, and Postgres does not support partial deferrable
--    unique constraints.
--
-- Grants: none needed. No new tables/sequences/RPCs; trigger functions do not
-- require EXECUTE for the writing role (EXECUTE is checked once at trigger
-- creation time, by the migration runner — #205 posture unaffected).

-- 1) Heal: renumber to unique sequential positions per kind.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY kind
           ORDER BY queue_position ASC,
                    (status = 'In Progress') DESC,
                    updated_at DESC,
                    id
         ) AS new_pos
  FROM public.content_items
  WHERE queue_position IS NOT NULL
)
UPDATE public.content_items ci
SET queue_position = r.new_pos
FROM ranked r
WHERE ci.id = r.id
  AND ci.queue_position IS DISTINCT FROM r.new_pos;

-- 2) Support index for the commit-time check (and queue-ordered reads).
CREATE INDEX IF NOT EXISTS content_items_kind_queue_position_idx
  ON public.content_items (kind, queue_position)
  WHERE queue_position IS NOT NULL;

-- 3) Guard.
CREATE OR REPLACE FUNCTION public.assert_unique_queue_position()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  dup_count integer;
BEGIN
  IF NEW.queue_position IS NULL THEN
    RETURN NULL;
  END IF;

  -- Runs at COMMIT (deferred): counts rows in the FINAL state holding this
  -- row's (kind, queue_position). A stale intermediate NEW value can only
  -- match final rows — so this never raises on a clean final state.
  SELECT count(*) INTO dup_count
  FROM public.content_items
  WHERE kind = NEW.kind
    AND queue_position = NEW.queue_position;

  IF dup_count > 1 THEN
    RAISE EXCEPTION 'duplicate queue_position % for kind % (item %)',
      NEW.queue_position, NEW.kind, NEW.id
      USING ERRCODE = '23505';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS content_items_unique_queue_position ON public.content_items;

CREATE CONSTRAINT TRIGGER content_items_unique_queue_position
AFTER INSERT OR UPDATE OF queue_position, kind ON public.content_items
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.assert_unique_queue_position();

COMMENT ON FUNCTION public.assert_unique_queue_position() IS
'Commit-time guard (#229): rejects any transaction whose final state holds
duplicate (kind, queue_position). Attached as a DEFERRABLE INITIALLY DEFERRED
constraint trigger on content_items so multi-row shifts that are transiently
duplicated mid-transaction still commit.';
