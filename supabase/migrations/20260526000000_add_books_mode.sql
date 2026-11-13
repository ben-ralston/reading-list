-- Migration: Books mode discriminator + nullable source link (#147)
-- Description:
--   Adds a `kind` column on content_items ('feed' | 'book') so the Books
--   section can share content_items / content_sources without splitting tables.
--   Relaxes content_sources.link to nullable so "Physical" book sources
--   (no URL) can exist alongside Audible / Kindle. Adds 'goodreads' to the
--   sync_logs source enum so the Goodreads CSV importer can log runs.
-- Date: 2026-05-26

-- content_items: discriminator for books vs feed
ALTER TABLE content_items
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'feed'
  CHECK (kind IN ('feed','book'));

-- Per-kind read paths always filter by kind; these indexes cover them.
CREATE INDEX IF NOT EXISTS idx_content_items_kind_queue
  ON content_items (kind, queue_position)
  WHERE queue_position IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_content_items_kind_status
  ON content_items (kind, status)
  WHERE status != '';

-- content_sources: link is now optional so a Physical book source can exist
-- without a URL. Dedup of (content_item, platform, link) — including the
-- nullable NULL-link case — is enforced by the insert_or_update_content RPC
-- via `IS NOT DISTINCT FROM` (see 20260526000001), not a DB constraint.
ALTER TABLE content_sources ALTER COLUMN link DROP NOT NULL;

-- sync_logs: allow 'goodreads' as a source for the one-shot importer.
-- Carries forward the full prior allowlist — including 'substack_import'
-- added in 20260525000000 for the daily Substack auto-importer cron (#163).
-- Dropping any of these would break a live ingest pipeline.
ALTER TABLE sync_logs DROP CONSTRAINT IF EXISTS sync_logs_valid_source;
ALTER TABLE sync_logs ADD CONSTRAINT sync_logs_valid_source
  CHECK (source IN ('spotify','audible','substack','elevenreader','rss','tasklet','substack_import','goodreads'));

COMMENT ON COLUMN content_items.kind IS
  'Discriminator: ''feed'' (default — newsletters / RSS / podcasts / articles) or ''book'' (Books mode, #147). Set on INSERT only; never updated.';
