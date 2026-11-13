-- place_item_in_queue: optional p_target_rank, resolved under the lock (#331).
--
-- Complete/Skip null an item's queue_position without closing up the queue,
-- so positions drift apart until the next drag-reorder renumbers them (a
-- feed of a hundred-odd items can span positions into the thousands). AI placement and Restore compute a
-- RANK (2..count+1), and passing it as a literal position landed every
-- auto-placed item ahead of everything numbered above it.
--
-- With p_target_rank set, the rank is resolved to the position the Nth item
-- of the kind holds — the shift then moves it and everything after it down —
-- or one past the last item when the queue is shorter. It is resolved AFTER
-- the content_items:multirow lock, so a concurrent renumber (drag-reorder,
-- remove_content_items gap close) can't leave it pointing at a stale
-- position. An empty queue keeps the rank as-is (rank 2 → position 2, never
-- the pinned position 1). Rank <= 0 is treated as 1.
--
-- Callers pass exactly one of p_target_position (literal, unchanged
-- semantics: makeNext and the integration suites) and p_target_rank.
-- Returns the position the item was placed at.
--
-- The old 5-arg function is dropped rather than overloaded: PostgREST
-- resolves RPCs by argument names, and two candidates that both accept the
-- 5 named args would be ambiguous.

DROP FUNCTION IF EXISTS public.place_item_in_queue(integer, text, integer, boolean, boolean);

CREATE FUNCTION public.place_item_in_queue(
  p_item_id integer,
  p_kind text,
  p_target_position integer,
  p_position_confirmed boolean,
  p_restore boolean DEFAULT false,
  p_target_rank integer DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_target integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('content_items:multirow'));

  IF (p_target_position IS NULL) = (p_target_rank IS NULL) THEN
    RAISE EXCEPTION 'place_item_in_queue: pass exactly one of p_target_position, p_target_rank';
  END IF;

  IF p_target_rank IS NULL THEN
    v_target := p_target_position;
  ELSE
    SELECT queue_position INTO v_target
    FROM content_items
    WHERE kind = p_kind
      AND queue_position IS NOT NULL
      AND id <> p_item_id
    ORDER BY queue_position
    OFFSET GREATEST(p_target_rank, 1) - 1
    LIMIT 1;

    IF v_target IS NULL THEN
      SELECT max(queue_position) + 1 INTO v_target
      FROM content_items
      WHERE kind = p_kind
        AND queue_position IS NOT NULL
        AND id <> p_item_id;
    END IF;

    v_target := COALESCE(v_target, GREATEST(p_target_rank, 1));
  END IF;

  UPDATE content_items
  SET queue_position = queue_position + 1
  WHERE kind = p_kind
    AND queue_position >= v_target
    AND id <> p_item_id;

  IF p_restore THEN
    UPDATE content_items
    SET status = '',
        queue_position = v_target,
        position_confirmed = p_position_confirmed,
        added_by = 'Restored',
        status_changed_at = now()
    WHERE id = p_item_id AND kind = p_kind;
  ELSE
    UPDATE content_items
    SET queue_position = v_target,
        position_confirmed = p_position_confirmed
    WHERE id = p_item_id AND kind = p_kind;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'place_item_in_queue: item % not found in kind %', p_item_id, p_kind;
  END IF;

  RETURN v_target;
END;
$$;

COMMENT ON FUNCTION public.place_item_in_queue(integer, text, integer, boolean, boolean, integer) IS
'Atomically shift the queue of one kind and place an item (#203 RLV-004), at a
literal p_target_position or at p_target_rank resolved to a live position under
the lock (#331: positions have gaps, ranks do not). Pass exactly one. Returns
the placed position. p_restore additionally clears Completed/Skip status,
stamps added_by=Restored and status_changed_at, in the same statement as the
position write (required by the completed_skip_no_position CHECK). Serialized
with every other multi-row content_items writer via the content_items:multirow
advisory lock (#337). Used by insertAtSmartPosition, restoreItem and makeNext.';

REVOKE EXECUTE ON FUNCTION public.place_item_in_queue(integer, text, integer, boolean, boolean, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.place_item_in_queue(integer, text, integer, boolean, boolean, integer) TO service_role;
