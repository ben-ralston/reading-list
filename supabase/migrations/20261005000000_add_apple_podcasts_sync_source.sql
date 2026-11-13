-- Migration: Allow 'apple_podcasts' as a sync_logs source (#322)
-- Description:
--   The Apple Podcasts listen-progress harvester (apple-podcasts-sync/, a
--   launchd job on the Mac reading the Podcasts app's local database) posts
--   to /api/sync as source 'apple_podcasts'. The route writes a sync_logs row
--   per run, which this CHECK would otherwise reject.
-- Date: 2026-10-05

-- Carries forward the full prior allowlist (see 20260718000000). Dropping any
-- of these would break a live ingest pipeline.
ALTER TABLE sync_logs DROP CONSTRAINT IF EXISTS sync_logs_valid_source;
ALTER TABLE sync_logs ADD CONSTRAINT sync_logs_valid_source
  CHECK (source IN ('spotify','audible','substack','elevenreader','rss','tasklet','substack_import','goodreads','askwhocasts','askwhocasts_public','apple_podcasts'));
