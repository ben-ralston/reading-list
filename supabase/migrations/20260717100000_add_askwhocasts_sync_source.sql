-- Migration: Allow 'askwhocasts' as a sync_logs source (#226)
-- Description:
--   The Askwho Casts private-feed sync cron
--   (app/api/cron/askwhocasts-sync/route.ts) inserts sync_logs rows with
--   source: 'askwhocasts'. The current sync_logs_valid_source CHECK
--   constraint does not include it, so every insert fails against a real DB.
-- Date: 2026-07-17

-- sync_logs: allow 'askwhocasts' as a source for the private-feed sync cron.
-- Carries forward the full prior allowlist — including 'goodreads' added in
-- 20260526000000 for the one-shot Goodreads CSV importer. Dropping any of
-- these would break a live ingest pipeline.
ALTER TABLE sync_logs DROP CONSTRAINT IF EXISTS sync_logs_valid_source;
ALTER TABLE sync_logs ADD CONSTRAINT sync_logs_valid_source
  CHECK (source IN ('spotify','audible','substack','elevenreader','rss','tasklet','substack_import','goodreads','askwhocasts'));
