-- Add 'rss' to the sync_logs source CHECK constraint.
-- RSS feed sync is now handled in-app instead of via Tasklet.

ALTER TABLE sync_logs
  DROP CONSTRAINT sync_logs_valid_source,
  ADD CONSTRAINT sync_logs_valid_source
  CHECK (source IN ('spotify', 'audible', 'substack', 'elevenreader', 'tasklet', 'rss'));
