-- Migration: Add place_item_in_queue RPC
-- Description: Atomic queue placement (#203 RLV-004). insertAtSmartPosition and
--              restoreItem used to do read -> shift (batch_update_content_items
--              by id list) -> place across 3-4 PostgREST calls; two concurrent
--              placements (user Restore racing the 15-min rss-sync cron insert)
--              interleaved on a stale shift list and persisted duplicate or lost
--              queue positions. This RPC does the shift as a single UPDATE
--              against live data and places the item in the same transaction,
--              serialized per kind by an advisory lock.
-- Date: 2026-07-11

CREATE OR REPLACE FUNCTION public.place_item_in_queue(
  p_item_id integer,
  p_kind text,
  p_target_position integer,
  p_position_confirmed boolean,
  p_restore boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- Serialize placements per kind. Released automatically at commit/rollback.
  PERFORM pg_advisory_xact_lock(hashtext('place_item_in_queue:' || p_kind));

  -- Shift items at/after the target position down by one, scoped to this kind
  -- so placing a book never renumbers feed items (and vice versa).
  UPDATE content_items
  SET queue_position = queue_position + 1
  WHERE kind = p_kind
    AND queue_position >= p_target_position
    AND id <> p_item_id;

  IF p_restore THEN
    -- Restoring an archived item: status and queue_position must change in the
    -- same statement — completed_skip_no_position forbids a position while the
    -- status is still 'Completed'/'Skip'.
    UPDATE content_items
    SET status = '',
        queue_position = p_target_position,
        position_confirmed = p_position_confirmed,
        added_by = 'Restored',
        status_changed_at = now()
    WHERE id = p_item_id AND kind = p_kind;
  ELSE
    UPDATE content_items
    SET queue_position = p_target_position,
        position_confirmed = p_position_confirmed
    WHERE id = p_item_id AND kind = p_kind;
  END IF;

  IF NOT FOUND THEN
    -- Rolls back the shift above too.
    RAISE EXCEPTION 'place_item_in_queue: item % not found in kind %', p_item_id, p_kind;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.place_item_in_queue(integer, text, integer, boolean, boolean) IS
'Atomically shift the queue of one kind and place an item at a target position
(#203 RLV-004). p_restore additionally clears Completed/Skip status, stamps
added_by=Restored and status_changed_at, in the same statement as the position
write (required by the completed_skip_no_position CHECK). Serialized per kind
via pg_advisory_xact_lock. Used by insertAtSmartPosition and restoreItem.';

-- #205 (RLV-010) posture: this app reaches Supabase only with the service_role
-- key; anon/authenticated must not be able to mutate the queue. Functions get
-- EXECUTE to PUBLIC by default, so revoke explicitly.
REVOKE EXECUTE ON FUNCTION public.place_item_in_queue(integer, text, integer, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.place_item_in_queue(integer, text, integer, boolean, boolean) TO service_role;
