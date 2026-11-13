-- Index to efficiently fetch the latest successful sync by source
-- Covers the query: SELECT MAX(completed_at) FROM sync_logs WHERE source = ? AND status = 'success'
CREATE INDEX idx_sync_logs_source_status_completed
ON sync_logs (source, status, completed_at DESC)
WHERE completed_at IS NOT NULL;
