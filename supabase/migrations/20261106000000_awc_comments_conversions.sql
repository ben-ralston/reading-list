-- #368: "Convert comments with Askwho Casts". A conversion now has a kind, and a
-- comments episode attaches as a second Askwho Casts source labelled 'Comments'.
--   * One active conversion per item, of either kind: the existing index stays.
--   * claim_awc_conversion takes the kinds its caller can run. The default is
--     article only, so a daemon that predates this migration can never claim a
--     comments row and spend credits turning it into an article episode.
--   * A comments episode isn't the article's audio, so it doesn't stop Spotify
--     reporting the article's progress (body from
--     20261104000000_spotify_progress_skip_awc.sql, plus the two filters).
BEGIN;

ALTER TABLE awc_conversions
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'article'
  CONSTRAINT awc_conversions_valid_kind CHECK (kind IN ('article', 'comments'));

-- The return type changes, so CREATE OR REPLACE can't be used.
DROP FUNCTION IF EXISTS claim_awc_conversion(INT, INT, INT);

CREATE FUNCTION claim_awc_conversion(
  p_stale_minutes INT DEFAULT 20,
  p_max_attempts INT DEFAULT 2,
  p_generating_hours INT DEFAULT 24,
  p_kinds TEXT[] DEFAULT ARRAY['article']
)
RETURNS TABLE (
  id BIGINT, content_item_id BIGINT, source_url TEXT, attempts INT,
  title TEXT, author TEXT, word_count INT, kind TEXT
)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
  v_id BIGINT;
BEGIN
  UPDATE awc_conversions c
  SET status = CASE WHEN c.attempts >= p_max_attempts THEN 'failed' ELSE 'queued' END,
      error = CASE WHEN c.attempts >= p_max_attempts THEN 'agent stalled' ELSE c.error END,
      completed_at = CASE WHEN c.attempts >= p_max_attempts THEN now() ELSE NULL END
  WHERE c.status = 'starting'
    AND c.updated_at < now() - make_interval(mins => p_stale_minutes);

  UPDATE awc_conversions c
  SET status = 'failed',
      error = 'agent stopped mid-run — check Askwho Casts before retrying',
      completed_at = now()
  WHERE c.status IN ('submitting_url', 'building_script')
    AND c.updated_at < now() - make_interval(mins => p_stale_minutes);

  UPDATE awc_conversions c
  SET status = 'failed', error = 'episode never arrived', completed_at = now()
  WHERE c.status = 'generating'
    AND COALESCE(c.generating_at, c.updated_at) < now() - make_interval(hours => p_generating_hours);

  SELECT c.id INTO v_id
  FROM awc_conversions c
  WHERE c.status = 'queued' AND c.kind = ANY(p_kinds)
  ORDER BY c.requested_at, c.id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF v_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE awc_conversions c
  SET status = 'starting', claimed_at = now(), attempts = c.attempts + 1, error = NULL
  WHERE c.id = v_id;

  RETURN QUERY
  SELECT c.id, c.content_item_id, c.source_url, c.attempts, i.title, i.author, i.word_count, c.kind
  FROM awc_conversions c
  JOIN content_items i ON i.id = c.content_item_id
  WHERE c.id = v_id;
END;
$$;

REVOKE ALL ON FUNCTION claim_awc_conversion(INT, INT, INT, TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_awc_conversion(INT, INT, INT, TEXT[]) TO service_role;

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
          AND source_label IS DISTINCT FROM 'Comments'
      ) OR EXISTS (
        SELECT 1 FROM public.awc_conversions
        WHERE content_item_id = current_item.id AND status NOT IN ('done', 'failed')
          AND kind = 'article'
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
