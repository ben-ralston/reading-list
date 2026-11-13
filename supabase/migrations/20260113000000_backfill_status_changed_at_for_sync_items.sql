-- Backfill status_changed_at for items marked Completed/Skip by sync processes
-- that didn't have this timestamp set (issue #77)
-- Uses updated_at as the best approximation since that's when the status change occurred

UPDATE content_items
SET status_changed_at = updated_at
WHERE status IN ('Completed', 'Skip')
  AND status_changed_at IS NULL;
