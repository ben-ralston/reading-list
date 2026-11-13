-- Add 'tasklet' to the sync_logs source CHECK constraint.
-- Tasklet was added as a valid sync source in PR #93 but the DB constraint was missed.

ALTER TABLE sync_logs
  DROP CONSTRAINT sync_logs_valid_source,
  ADD CONSTRAINT sync_logs_valid_source
  CHECK (source IN ('spotify', 'audible', 'substack', 'elevenreader', 'tasklet'));
