-- Migration: Add source_label to content_sources (#245)
--
-- Since #237 an item can carry several Spotify episode rows (the AWC AI reading
-- plus a human-narrated official episode). Both source-dropdown render paths
-- label every row "Open on ${platform}", so those rows appear as two identical
-- "Open on Spotify" entries with nothing to tell them apart. content_sources had
-- no title/name column, so the UI could not disambiguate from data it held.
--
-- What distinguishes the rows is the SHOW, not the episode: prod item 610 holds
-- "SOTA On Bay Area House Party" (Astral Codex Ten Podcast) and "SOTA On Bay Area
-- House Party - By Scott Alexander" (AI Article Readings) — near-identical episode
-- titles, unmistakable show names.
--
-- Deliberately generic rather than a Spotify-specific show_name: a future YouTube
-- channel or second Substack publication can reuse the same column and the same
-- "disambiguate only when a platform repeats" UI rule with no further migration.
--
-- Nullable with no backfill here. Existing rows read NULL and render exactly as
-- they do today; scripts/spotify-show-backfill.ts fills them from the Spotify API
-- and both sync attach paths populate it going forward.
--
-- No index: never a filter, only a projected column in the queue payload.
--
-- Grants: none needed. No new tables/sequences/RPCs, and content_sources predates
-- the auto-grant-removal rule with no table-level grant of its own — adding a
-- column inherits the table's existing privileges (#205 posture unaffected).

ALTER TABLE content_sources ADD COLUMN IF NOT EXISTS source_label TEXT;

COMMENT ON COLUMN content_sources.source_label IS
  'Human-readable name of the specific source within the platform (e.g. the Spotify show name). Used to disambiguate when one item has several sources on the same platform (#245).';

-- POST-MIGRATION VERIFICATION
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'content_sources'
      AND column_name = 'source_label'
  ) THEN
    RAISE EXCEPTION 'content_sources.source_label column was not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'content_sources'
      AND column_name = 'source_label'
      AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'content_sources.source_label must be nullable (legacy rows carry no label)';
  END IF;

  RAISE NOTICE 'Migration completed successfully: content_sources.source_label added';
END $$;
