-- Migration: Allow 'askwhocasts_public' as a sync_logs source (#237)
-- Description:
--   The public Askwho Casts sync phase (app/api/cron/askwhocasts-sync/route.ts)
--   logs under source: 'askwhocasts_public', separate from the private feed's
--   'askwhocasts' row so /settings/status can distinguish their health.
-- Date: 2026-07-18

-- Carries forward the full prior allowlist (see 20260717100000). Dropping any
-- of these would break a live ingest pipeline.
ALTER TABLE sync_logs DROP CONSTRAINT IF EXISTS sync_logs_valid_source;
ALTER TABLE sync_logs ADD CONSTRAINT sync_logs_valid_source
  CHECK (source IN ('spotify','audible','substack','elevenreader','rss','tasklet','substack_import','goodreads','askwhocasts','askwhocasts_public'));

-- Multi-episode support: an item may now carry SEVERAL Spotify episode rows
-- (e.g. the Askwho Casts reading AND a human-narrated official episode), so
-- the one-non-null-external_id-row-per-(item, platform) rule from
-- 20260103000001 no longer holds. Its comment claimed it "allows multiple
-- sources per platform only if they have different external_ids", but the
-- actual DDL omitted external_id from the key — with it in force, every
-- second-episode attach fails 23505 and the #237 feature silently no-ops.
-- Real duplicate protection is unaffected after the drop:
--   * unique_platform_external_id UNIQUE (platform, external_id) — a given
--     episode can only exist once, anywhere (20251211000000);
--   * unique_source_per_item UNIQUE (content_item_id, platform, link) —
--     no identical-link duplicates, including NULL-external_id legacy rows.
DROP INDEX IF EXISTS content_sources_item_platform_idx;
