-- Migration: Add rss_feeds.backfill_days for opt-in first-poll backfill (#164)
-- Description: NULL = no backfill (default). When set on a never-polled feed,
--   the RSS cron ingests items published within the last backfill_days days on
--   the feed's first successful poll, then reverts to the global cutoff.
-- Date: 2026-06-10

ALTER TABLE rss_feeds
  ADD COLUMN IF NOT EXISTS backfill_days INTEGER
  CHECK (backfill_days > 0 AND backfill_days <= 3650);

COMMENT ON COLUMN rss_feeds.backfill_days IS
  'Opt-in first-poll backfill window in days (NULL = off). Inert after last_success_at is set.';
