-- #266: listening completion is not article completion for LessWrong.
BEGIN;
ALTER TABLE public.content_items DROP CONSTRAINT valid_status_values;
ALTER TABLE public.content_items ADD CONSTRAINT valid_status_values
  CHECK (status IN ('', 'In Progress', 'Awaiting comments', 'Completed', 'Skip'));

-- Keep the policy at the write boundary: callers must send the incoming Spotify
-- state, not a status decision made from a potentially stale queue snapshot.
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

-- Non-Spotify automatic updates retain their existing progress behavior, but
-- cannot complete or reset a pending discussion. A single UPDATE re-evaluates
-- the status after waiting for any concurrent writer.
CREATE OR REPLACE FUNCTION public.apply_content_progress(
  p_item_id bigint, p_progress text, p_status text, p_skip_archived boolean DEFAULT false
) RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF p_status IS NOT NULL AND p_status NOT IN ('In Progress', 'Completed') THEN
    RAISE EXCEPTION 'Invalid automatic status';
  END IF;
  IF p_progress IS NULL AND p_status IS NULL THEN RETURN; END IF;
  UPDATE public.content_items SET
    progress = COALESCE(p_progress, progress),
    status = CASE WHEN status = 'Awaiting comments' THEN status ELSE COALESCE(p_status, status) END,
    status_changed_at = CASE WHEN status <> 'Awaiting comments' AND p_status IS NOT NULL THEN now() ELSE status_changed_at END,
    queue_position = CASE WHEN status <> 'Awaiting comments' AND p_status = 'Completed' THEN NULL ELSE queue_position END,
    position_confirmed = CASE WHEN status <> 'Awaiting comments' AND p_status = 'Completed' THEN false ELSE position_confirmed END
  WHERE id = p_item_id AND (NOT p_skip_archived OR status NOT IN ('Completed', 'Skip'));
END;
$$;
REVOKE ALL ON FUNCTION public.apply_content_progress(bigint,text,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_content_progress(bigint,text,text,boolean) TO service_role;

-- Keep the legacy externally callable sync entry point consistent.
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


COMMIT;
