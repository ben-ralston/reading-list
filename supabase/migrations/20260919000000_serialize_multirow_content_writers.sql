-- Migration: Serialize every multi-row content_items writer behind one advisory lock
-- Description: ops issue #337. On 2026-09-14 20:15 the rss-sync
--   cron placed a new item via place_item_in_queue (range shift, locks rows in
--   queue_position order) while the spotify-sync cron ran apply_spotify_progress
--   (locks matched rows FOR UPDATE ORDER BY id). Two multi-row writers, two lock
--   orders, nothing serializing them: Postgres aborted the Spotify run with 40P01.
--   place_item_in_queue's per-kind advisory lock only serialized placements
--   against each other; batch_update_content_items (user reorder / Make Next) and
--   the legacy sync_progress loop had no lock at all.
--
--   Fix: every function that can hold more than one content_items row lock takes
--   pg_advisory_xact_lock(hashtext('content_items:multirow')) as its FIRST
--   statement, before any row lock. Transaction-scoped on purpose: never use the
--   session-level pg_advisory_lock here (PostgREST / pooler connections are reused).
--
--   Invariant this relies on — keep it true: outside these four functions, no single
--   statement and no transaction touches more than one content_items row. Every
--   app-side update chains .eq('id', ...), apply_content_progress is one
--   UPDATE ... WHERE id = p_item_id, delete_orphan_content_item locks one row,
--   upsert_content_item inserts a brand-new row nobody else references yet. Any
--   new multi-row writer (an .in('id', ids).update(...) backfill, a new range
--   shift) must take the same lock first or it reopens this deadlock.
-- Date: 2026-09-19

BEGIN;

-- ---------------------------------------------------------------------------
-- apply_spotify_progress: body from 20260913000000_awaiting_comments.sql,
-- plus the shared lock ahead of the FOR UPDATE.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_spotify_progress(updates jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  entry jsonb;
  current_item public.content_items%ROWTYPE;
  next_status text;
  next_progress text;
  incoming_percent numeric;
  current_percent numeric;
  is_lesswrong boolean;
BEGIN
  -- #337: serialize with every other multi-row content_items writer BEFORE
  -- taking any row lock. Released automatically at commit/rollback.
  PERFORM pg_advisory_xact_lock(hashtext('content_items:multirow'));

  IF jsonb_typeof(updates) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'updates must be an array';
  END IF;
  -- Acquire all content-row locks in a stable order, including duplicate IDs.
  PERFORM id FROM public.content_items
    WHERE id IN (SELECT (value->>'id')::bigint FROM jsonb_array_elements(updates))
    ORDER BY id FOR UPDATE;

  FOR entry IN SELECT value FROM jsonb_array_elements(updates) LOOP
    SELECT * INTO current_item FROM public.content_items WHERE id = (entry->>'id')::bigint;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF entry->>'status' IS NOT NULL AND entry->>'status' NOT IN ('In Progress', 'Completed') THEN
      RAISE EXCEPTION 'Invalid Spotify status';
    END IF;
    SELECT current_item.kind = 'feed' AND EXISTS (
      SELECT 1 FROM public.content_sources
      WHERE content_item_id = current_item.id AND platform = 'LessWrong'
    ) INTO is_lesswrong;

    next_status := COALESCE(entry->>'status', current_item.status);
    IF current_item.status IN ('Completed', 'Awaiting comments')
       OR (current_item.status = 'Skip' AND (is_lesswrong OR next_status <> 'Completed')) THEN
      next_status := current_item.status;
    ELSIF is_lesswrong AND next_status = 'Completed' THEN
      next_status := 'Awaiting comments';
    END IF;

    next_progress := current_item.progress;
    -- Match the existing parseFloat high-water rule, including legacy text.
    incoming_percent := substring(entry->>'progress' FROM '^\s*([+-]?[0-9]+(?:\.[0-9]+)?)')::numeric;
    current_percent := substring(current_item.progress FROM '^\s*([+-]?[0-9]+(?:\.[0-9]+)?)')::numeric;
    IF incoming_percent IS NOT NULL AND (current_percent IS NULL OR incoming_percent > current_percent) THEN
      next_progress := entry->>'progress';
    END IF;

    UPDATE public.content_items SET
      progress = next_progress,
      status = next_status,
      status_changed_at = CASE WHEN next_status <> current_item.status THEN now() ELSE status_changed_at END,
      queue_position = CASE WHEN next_status = 'Completed' AND next_status <> current_item.status THEN NULL ELSE queue_position END,
      position_confirmed = CASE WHEN next_status = 'Completed' AND next_status <> current_item.status THEN false ELSE position_confirmed END
    WHERE id = current_item.id
      AND (status IS DISTINCT FROM next_status OR progress IS DISTINCT FROM next_progress);
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.apply_spotify_progress(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_spotify_progress(jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- place_item_in_queue: body from 20260711000000_add_place_item_in_queue.sql.
-- The per-kind key becomes the global key (a strict superset: the shift is
-- still scoped to p_kind, only book-vs-feed placement concurrency is lost).
-- ---------------------------------------------------------------------------
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
  -- #337: shared multi-row writer lock, taken before the shift's row locks.
  -- Released automatically at commit/rollback.
  PERFORM pg_advisory_xact_lock(hashtext('content_items:multirow'));

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
write (required by the completed_skip_no_position CHECK). Serialized with every
other multi-row content_items writer via the content_items:multirow advisory
lock (#337). Used by insertAtSmartPosition and restoreItem.';

REVOKE EXECUTE ON FUNCTION public.place_item_in_queue(integer, text, integer, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.place_item_in_queue(integer, text, integer, boolean, boolean) TO service_role;

-- ---------------------------------------------------------------------------
-- batch_update_content_items: body from 20260303000000_extend_batch_update_progress.sql.
-- Updates rows in client payload order, so it needs the lock too.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.batch_update_content_items(updates jsonb)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  update_item jsonb;
  item_id integer;
BEGIN
  -- #337: shared multi-row writer lock, taken before the first row lock.
  PERFORM pg_advisory_xact_lock(hashtext('content_items:multirow'));

  -- Iterate through each update in the array
  FOR update_item IN SELECT * FROM jsonb_array_elements(updates)
  LOOP
    -- Extract ID
    item_id := (update_item->>'id')::integer;

    -- Build and execute dynamic UPDATE statement based on provided fields
    -- This allows partial updates (only update fields that are present in JSON)
    UPDATE content_items
    SET
      status = COALESCE(
        CASE WHEN update_item ? 'status'
          THEN (update_item->>'status')::text
          ELSE NULL
        END,
        status
      ),
      queue_position = CASE
        WHEN update_item ? 'queue_position' THEN
          CASE
            WHEN update_item->>'queue_position' = 'null' THEN NULL
            ELSE (update_item->>'queue_position')::integer
          END
        ELSE queue_position
      END,
      position_confirmed = COALESCE(
        CASE WHEN update_item ? 'position_confirmed'
          THEN (update_item->>'position_confirmed')::boolean
          ELSE NULL
        END,
        position_confirmed
      ),
      progress = COALESCE(
        CASE WHEN update_item ? 'progress'
          THEN (update_item->>'progress')::text
          ELSE NULL
        END,
        progress
      ),
      status_changed_at = CASE
        WHEN update_item ? 'status_changed_at' THEN
          CASE
            WHEN update_item->>'status_changed_at' = 'null' THEN NULL
            ELSE (update_item->>'status_changed_at')::timestamptz
          END
        ELSE status_changed_at
      END
    WHERE id = item_id;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.batch_update_content_items(jsonb) IS
'Batch update multiple content items in a single transaction. Accepts a JSONB
array of updates with optional fields: status, queue_position,
position_confirmed, progress, status_changed_at. Rows are updated in payload
order, so the call is serialized with every other multi-row content_items
writer via the content_items:multirow advisory lock (#337). Used by the
queue/books batch route (lib/content/queue-route.ts); the Spotify sync moved to
apply_spotify_progress.';

REVOKE EXECUTE ON FUNCTION public.batch_update_content_items(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.batch_update_content_items(jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- sync_progress: legacy SQL entry point, body from 20260913000000. Its
-- 'spotify' branch inherits the lock through apply_spotify_progress, but the
-- other branch loops one UPDATE per item with no lock. No app code calls it,
-- but it is executable by service_role, so it takes the lock as well.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync_progress(
  p_source TEXT,
  p_items JSONB
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_sync_log_id BIGINT;
  v_item JSONB;
  v_content_id BIGINT;
  v_title TEXT;
  v_author TEXT;
  v_external_id TEXT;
  v_progress TEXT;
  v_status TEXT;
  v_processed INT := 0;
  v_updated INT := 0;
  v_skipped INT := 0;
BEGIN
  -- #337: shared multi-row writer lock, taken before the first row lock.
  PERFORM pg_advisory_xact_lock(hashtext('content_items:multirow'));

  -- Validate source
  IF p_source IS NULL OR p_source NOT IN ('spotify', 'audible', 'substack', 'elevenreader') THEN
    RAISE EXCEPTION 'Invalid source. Must be one of: spotify, audible, substack, elevenreader';
  END IF;

  -- Validate items is an array
  IF p_items IS NULL OR jsonb_typeof(p_items) != 'array' THEN
    RAISE EXCEPTION 'Items must be a JSON array';
  END IF;

  -- Create sync log entry
  INSERT INTO sync_logs (source, status, items_processed, items_updated, items_skipped)
  VALUES (p_source, 'running', 0, 0, 0)
  RETURNING id INTO v_sync_log_id;

  -- Process each item
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    -- Extract fields
    v_title := v_item->>'title';
    v_author := v_item->>'author';
    v_external_id := v_item->>'external_id';
    v_progress := v_item->>'progress';
    v_status := v_item->>'status';

    -- Skip items without required fields
    IF v_title IS NULL OR TRIM(v_title) = '' OR v_author IS NULL OR TRIM(v_author) = '' THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- Validate status if provided
    IF v_status IS NOT NULL AND v_status NOT IN ('In Progress', 'Completed') THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_content_id := NULL;

    -- Strategy 1: Match by external_id
    IF v_external_id IS NOT NULL AND TRIM(v_external_id) != '' THEN
      SELECT content_item_id INTO v_content_id
      FROM content_sources
      WHERE external_id = v_external_id
      LIMIT 1;
    END IF;

    -- Strategy 2: Fall back to title + author match
    IF v_content_id IS NULL THEN
      SELECT id INTO v_content_id
      FROM content_items
      WHERE LOWER(TRIM(title)) = LOWER(TRIM(v_title))
        AND LOWER(TRIM(author)) = LOWER(TRIM(v_author))
      LIMIT 1;
    END IF;

    -- Update if match found
    IF v_content_id IS NOT NULL THEN
      IF p_source = 'spotify' THEN
        PERFORM public.apply_spotify_progress(jsonb_build_array(jsonb_build_object(
          'id', v_content_id, 'progress', v_progress, 'status', v_status)));
      ELSE
        UPDATE public.content_items SET
          progress = COALESCE(v_progress, progress),
          status = CASE WHEN status = 'Awaiting comments' THEN status ELSE COALESCE(v_status, status) END,
          updated_at = now()
        WHERE id = v_content_id;
      END IF;

      v_updated := v_updated + 1;
    ELSE
      v_skipped := v_skipped + 1;
    END IF;

    v_processed := v_processed + 1;
  END LOOP;

  -- Update sync log with results
  UPDATE sync_logs
  SET
    status = 'success',
    completed_at = NOW(),
    items_processed = v_processed,
    items_updated = v_updated,
    items_skipped = v_skipped
  WHERE id = v_sync_log_id;

  -- Return results
  RETURN jsonb_build_object(
    'sync_log_id', v_sync_log_id,
    'processed', v_processed,
    'updated', v_updated,
    'skipped', v_skipped
  );

EXCEPTION WHEN OTHERS THEN
  -- Update sync log with error
  IF v_sync_log_id IS NOT NULL THEN
    UPDATE sync_logs
    SET
      status = 'error',
      completed_at = NOW(),
      error_message = SQLERRM,
      items_processed = v_processed,
      items_updated = v_updated,
      items_skipped = v_skipped
    WHERE id = v_sync_log_id;
  END IF;

  RAISE;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.sync_progress(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_progress(text, jsonb) TO service_role;

COMMIT;
