-- Migration: Substack auto-import (#149 Phase 2)
-- Description:
--   1. Add a `source` provenance column to rss_feeds, distinguishing auto-imported
--      Substack feeds from hand-added / seeded ones. Existing rows default to 'manual'
--      (they were hand-curated) — which also keeps the importer from ever auto-disabling
--      them, since the disable pass is scoped to 'substack_auto' rows.
--   2. Allow 'substack_import' as a sync_logs source for the daily importer's health row
--      (surfaced on /settings/status).
-- Date: 2026-05-25

ALTER TABLE rss_feeds
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual', 'substack_auto'));

COMMENT ON COLUMN rss_feeds.source IS
  'How the feed entered the table: ''manual'' (seeded/UI-added) or ''substack_auto'' (Substack importer).';

ALTER TABLE sync_logs
  DROP CONSTRAINT sync_logs_valid_source,
  ADD CONSTRAINT sync_logs_valid_source
  CHECK (source IN ('spotify', 'audible', 'substack', 'elevenreader', 'tasklet', 'rss', 'substack_import'));
