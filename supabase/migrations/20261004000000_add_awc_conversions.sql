-- Migration: Add awc_conversions queue + claim RPC
-- Description: Requests to convert a queue item into an Askwho Casts episode.
--   The app inserts 'queued' rows; the Mac daemon (awc-agent/) claims them via
--   claim_awc_conversion() and reports stages; askwhocasts-sync marks 'done'.
-- Date: 2026-10-04
-- Related: GitHub Issue #317

CREATE TABLE IF NOT EXISTS awc_conversions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  content_item_id BIGINT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued'
    CONSTRAINT awc_conversions_valid_status CHECK (status IN
      ('queued', 'starting', 'submitting_url', 'building_script', 'generating', 'done', 'failed')),
  source_url TEXT NOT NULL CONSTRAINT awc_conversions_http_url CHECK (source_url ~ '^https?://'),
  path TEXT CONSTRAINT awc_conversions_valid_path CHECK (path IN ('url', 'script')),
  episode_title TEXT,
  credits INT,
  error TEXT,
  attempts INT NOT NULL DEFAULT 0,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  generating_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE awc_conversions IS
'Askwho Casts conversion requests (#317). One active (not done/failed) row per
item. episode_title is the match key for link-less Script-tab episodes.';

-- A double tap (or two devices) must not queue the same item twice.
CREATE UNIQUE INDEX IF NOT EXISTS awc_conversions_one_active_per_item
  ON awc_conversions (content_item_id) WHERE status NOT IN ('done', 'failed');
CREATE INDEX IF NOT EXISTS awc_conversions_status_requested
  ON awc_conversions (status, requested_at);

CREATE TRIGGER awc_conversions_updated_at
  BEFORE UPDATE ON awc_conversions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE awc_conversions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON awc_conversions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Explicit Data-API grants (CLAUDE.md): service_role only.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.awc_conversions TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.awc_conversions_id_seq TO service_role;

-- Claim the next queued conversion for the Mac daemon. Before claiming:
--   * rows stuck in 'starting' for p_stale_minutes (daemon killed before the
--     agent did anything) go back to 'queued', or 'failed' once attempts
--     reach p_max_attempts;
--   * rows stuck mid-run ('submitting_url' / 'building_script') are FAILED,
--     never requeued: the agent may already have clicked Generate before it
--     died, and an automatic retry would pay for a second episode;
--   * 'generating' rows older than p_generating_hours fail (episode never
--     reached the feed).
-- FOR UPDATE SKIP LOCKED makes concurrent claimers safe. Touches only
-- awc_conversions rows, so the content_items:multirow advisory lock is not needed.
CREATE OR REPLACE FUNCTION claim_awc_conversion(
  p_stale_minutes INT DEFAULT 20,
  p_max_attempts INT DEFAULT 2,
  p_generating_hours INT DEFAULT 24
)
RETURNS TABLE (
  id BIGINT, content_item_id BIGINT, source_url TEXT, attempts INT,
  title TEXT, author TEXT, word_count INT
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
  WHERE c.status = 'queued'
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
  SELECT c.id, c.content_item_id, c.source_url, c.attempts, i.title, i.author, i.word_count
  FROM awc_conversions c
  JOIN content_items i ON i.id = c.content_item_id
  WHERE c.id = v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION claim_awc_conversion(INT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_awc_conversion(INT, INT, INT) TO service_role;

-- POST-MIGRATION VERIFICATION
DO $$
BEGIN
  IF to_regclass('public.awc_conversions') IS NULL THEN
    RAISE EXCEPTION 'awc_conversions table was not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'claim_awc_conversion') THEN
    RAISE EXCEPTION 'claim_awc_conversion function was not created';
  END IF;
  IF has_table_privilege('anon', 'public.awc_conversions', 'SELECT') THEN
    RAISE EXCEPTION 'anon must not have SELECT on awc_conversions';
  END IF;
END $$;
