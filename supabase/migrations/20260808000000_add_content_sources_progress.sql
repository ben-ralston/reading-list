-- Per-source progress (#194): the platform's own last-seen position percent,
-- written by the Spotify hourly cron and the /api/sync harvesters (Substack,
-- Audible). Deliberately NOT a high-water mark (unlike content_items.progress):
-- the Resume-on-Spotify gate needs to know when a source's position is BEHIND
-- the item's read position, so regressions (e.g. a Spotify re-listen) must be
-- visible. NULL = that platform has never reported a position since this
-- column shipped (historical raw positions were discarded at ingest).
-- No new grants: table-level grants on content_sources already materialized.
ALTER TABLE public.content_sources
  ADD COLUMN progress INTEGER
  CONSTRAINT content_sources_progress_range CHECK (progress >= 0 AND progress <= 100);
