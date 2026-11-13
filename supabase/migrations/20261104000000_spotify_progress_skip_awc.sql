-- #364: The owner converts a post because the Askwho Casts reading beats its Spotify
-- audio. From the moment a conversion is requested, Spotify's report for that
-- item is ignored, so an old played episode can't complete or re-archive what he
-- is now hearing through Askwho Casts. Apple Podcasts reports that episode
-- itself and sends no 'source', so it still completes the item.
-- Body from 20260919000000_serialize_multirow_content_writers.sql, plus the skip.
-- Old callers omit 'source' and the old body ignores it, so either deploy order
-- is safe.
BEGIN;

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
    IF entry->>'source' = 'spotify' AND (
      EXISTS (
        SELECT 1 FROM public.content_sources
        WHERE content_item_id = current_item.id AND platform = 'Askwho Casts'
      ) OR EXISTS (
        SELECT 1 FROM public.awc_conversions
        WHERE content_item_id = current_item.id AND status NOT IN ('done', 'failed')
      )
    ) THEN
      CONTINUE;
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

COMMIT;
