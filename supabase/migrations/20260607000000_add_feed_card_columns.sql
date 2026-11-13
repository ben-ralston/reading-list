-- Migration: Add feed-card enrichment columns to content_items (#167)
-- Description:
--   Richer, scannable feed cards need a preview thumbnail and a read/listen
--   length estimate per item. These three nullable columns hold the raw signals
--   captured at sync time (and via the one-off backfill); the UI derives the
--   thumbnail vs. source-tinted placeholder and the "N min read/listen" label.
--   Sibling to book covers (#168), which is out of scope here.
--
--   No GRANTs: ALTER TABLE add-column on an existing table inherits the
--   table-level grants already materialized on content_items (same as
--   20260314000000_add_summary_columns.sql and 20260526000000_add_books_mode.sql).
-- Date: 2026-06-07

ALTER TABLE content_items ADD COLUMN image_url TEXT;
ALTER TABLE content_items ADD COLUMN word_count INT;
ALTER TABLE content_items ADD COLUMN duration_seconds INT;

COMMENT ON COLUMN content_items.image_url IS
  '#167 resolved preview thumbnail URL (RSS enclosure/itunes:image/media:thumbnail, '
  'YouTube-derived, Spotify API image, or scraped og:image). NULL = no image; the '
  'UI shows a source-tinted placeholder.';
COMMENT ON COLUMN content_items.word_count IS
  '#167 raw word count of the post body, for the read-time estimate (formatted in '
  'the UI at a re-tunable ~225 wpm). NULL for audio/video or when unknown.';
COMMENT ON COLUMN content_items.duration_seconds IS
  '#167 raw audio/video duration in seconds, for the listen/watch-time estimate. '
  'NULL for text or when unknown.';
