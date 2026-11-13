-- Migration: Add external_id column to content_sources
-- Description: Enable matching by platform-specific identifiers (e.g., spotify:episode:xxx)
-- Date: 2025-11-29
-- Related: Progress Sync feature (GitHub Issue #4)

-- PRE-MIGRATION VERIFICATION
DO $$
BEGIN
  -- Verify content_sources table exists
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'content_sources') THEN
    RAISE EXCEPTION 'content_sources table does not exist';
  END IF;
END $$;

-- Add external_id column for platform-specific identifiers
ALTER TABLE content_sources ADD COLUMN IF NOT EXISTS external_id TEXT;

-- Index for fast lookups by external_id
CREATE INDEX IF NOT EXISTS idx_content_sources_external_id
  ON content_sources (external_id)
  WHERE external_id IS NOT NULL;

-- Composite unique constraint: platform + external_id must be unique
-- (same content could have spotify:episode:xxx AND audible:xxx - that's fine)
ALTER TABLE content_sources
  ADD CONSTRAINT unique_platform_external_id
  UNIQUE (platform, external_id);

-- Add comment explaining the column
COMMENT ON COLUMN content_sources.external_id IS
'Platform-specific identifier for matching (e.g., spotify:episode:xxx, audible:B08XXX).
Used by progress sync to match incoming updates to existing content.';

-- POST-MIGRATION VERIFICATION
DO $$
BEGIN
  -- Verify column was added
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'content_sources' AND column_name = 'external_id'
  ) THEN
    RAISE EXCEPTION 'external_id column was not created';
  END IF;

  -- Verify index exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'idx_content_sources_external_id'
  ) THEN
    RAISE EXCEPTION 'Index idx_content_sources_external_id was not created';
  END IF;

  -- Verify constraint exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'unique_platform_external_id'
  ) THEN
    RAISE EXCEPTION 'Constraint unique_platform_external_id was not created';
  END IF;

  RAISE NOTICE 'Migration completed successfully: external_id column added to content_sources';
END $$;
