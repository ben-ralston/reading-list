-- Migration: Claude-curated picks (curation_runs + shortlist state)
-- Description: The Mac job queue-curator/ ranks the feed queue with Claude
--   about once an hour and saves each run here. The home screen will show the
--   latest succeeded run's picks. Two columns on content_items hold the
--   user's own overrides: "Make next" (pinned_at) and "Not now"
--   (shortlist_dismissed_at).
-- Date: 2026-11-09

-- content_items is written every few minutes by the sync jobs. ADD COLUMN
-- and CREATE TRIGGER need brief exclusive locks on it; fail fast rather than
-- queue every reader and writer behind a slow one.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS curation_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL
    CONSTRAINT curation_runs_valid_status CHECK (status IN ('succeeded', 'failed')),
  mode TEXT NOT NULL,
  model TEXT NOT NULL,
  items_considered INT NOT NULL DEFAULT 0,
  input_hash TEXT NOT NULL,
  -- [{ "id": <content_items.id>, "reason": <text or null> }, ...] in rank order.
  -- Deliberately not a foreign key: ids are matched against active items when
  -- read, so deleting an item never has to know about picks.
  picks JSONB NOT NULL DEFAULT '[]'::jsonb
    CONSTRAINT curation_runs_picks_is_array CHECK (jsonb_typeof(picks) = 'array'),
  tool_summary JSONB,
  error TEXT
);

COMMENT ON TABLE curation_runs IS
'One row per queue-curator run. Readers use the latest row with status
succeeded; a failed run leaves the previous picks in place. The curator never
writes content_items.';

CREATE INDEX IF NOT EXISTS curation_runs_status_finished
  ON curation_runs (status, finished_at DESC);

ALTER TABLE curation_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for service role" ON curation_runs;
CREATE POLICY "Allow all for service role" ON curation_runs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Explicit Data-API grants (CLAUDE.md): service_role only.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.curation_runs TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.curation_runs_id_seq TO service_role;

-- The user's own shortlist overrides. Single-row state: writers that set
-- them touch one row by id, so the content_items:multirow advisory lock is
-- not needed.
ALTER TABLE content_items
  ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS shortlist_dismissed_at TIMESTAMPTZ;

COMMENT ON COLUMN content_items.pinned_at IS
'Set by "Make next" (and for hand-added items): shown above Claude''s picks, newest pin first. Cleared when the item is archived.';
COMMENT ON COLUMN content_items.shortlist_dismissed_at IS
'Set by "Not now": kept off the shortlist for a hold period, then eligible again. Cleared when the item is archived.';

-- Several independent writers archive items (the Spotify and other progress
-- RPCs, the feedback agent, the queue route). None of them should need to
-- know about pins, so the row clears its own shortlist state when it is
-- archived; a restored item comes back unpinned.
CREATE OR REPLACE FUNCTION clear_shortlist_state_on_archive()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN ('Completed', 'Skip') THEN
    NEW.pinned_at := NULL;
    NEW.shortlist_dismissed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION clear_shortlist_state_on_archive() FROM PUBLIC;

DROP TRIGGER IF EXISTS content_items_clear_shortlist_state ON content_items;
CREATE TRIGGER content_items_clear_shortlist_state
  BEFORE INSERT OR UPDATE ON content_items
  FOR EACH ROW
  EXECUTE FUNCTION clear_shortlist_state_on_archive();
