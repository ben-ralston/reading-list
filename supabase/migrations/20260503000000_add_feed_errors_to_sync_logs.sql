-- Add feed_errors column + extend status CHECK to include 'partial'.
-- Closes #132: persist per-sync feed failure count to sync_logs so degraded
-- syncs are visible from the DB without inspecting cron worker logs.
--
-- Per-feed details (URL + reason) live in metadata->'feedErrors' as a JSON
-- array; the column here is just the count for fast filtering.

ALTER TABLE sync_logs
  ADD COLUMN IF NOT EXISTS feed_errors INT DEFAULT 0;

COMMENT ON COLUMN sync_logs.feed_errors IS
  'Number of feeds that failed to fetch during this sync (RSS only today). Pair with metadata->feedErrors for per-feed details.';

ALTER TABLE sync_logs
  DROP CONSTRAINT sync_logs_valid_status,
  ADD CONSTRAINT sync_logs_valid_status
  CHECK (status IN ('running', 'success', 'partial', 'error'));
