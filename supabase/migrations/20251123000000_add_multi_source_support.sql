-- Migration 005: Add Multi-Source Support with Deduplication
-- Description: Migrates from single queue_items table to content_items + content_sources
--              Enables multiple sources per content item with automatic deduplication
-- Date: 2025-11-15

-- ============================================================================
-- PRE-MIGRATION VERIFICATION
-- ============================================================================

-- Check current record count (baseline for verification)
SELECT COUNT(*) as baseline_record_count FROM queue_items;

-- Verify update_updated_at_column() function exists (needed for trigger)
SELECT routine_name FROM information_schema.routines
WHERE routine_name = 'update_updated_at_column';
-- Should return 1 row

-- Check for constraint violations before migration
SELECT id, title, status, queue_position
FROM queue_items
WHERE status IN ('Completed', 'Skip') AND queue_position IS NOT NULL;
-- Should return 0 rows

SELECT id, title, position_confirmed, queue_position
FROM queue_items
WHERE position_confirmed = TRUE AND queue_position IS NULL;
-- Should return 0 rows

-- Display sample data before migration
SELECT id, title, author, platform, link, status, queue_position
FROM queue_items
ORDER BY id
LIMIT 5;

-- ============================================================================
-- TABLE CREATION: content_items
-- ============================================================================

-- Create content_items table (one row per unique content)
-- Preserves all queue management fields from queue_items
CREATE TABLE content_items (
  -- Primary key
  id BIGSERIAL PRIMARY KEY,

  -- Content identification (deduplication based on title + author)
  title TEXT NOT NULL,
  author TEXT NOT NULL,

  -- Publication date (original content publish date)
  published_on TIMESTAMPTZ NULL,

  -- Queue management fields
  status TEXT NOT NULL DEFAULT '',
  queue_position BIGINT NULL,
  position_confirmed BOOLEAN NOT NULL DEFAULT FALSE,

  -- Progress tracking (content-level, not source-specific)
  progress TEXT NULL,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add CHECK constraints (ported from queue_items)
ALTER TABLE content_items
ADD CONSTRAINT valid_status_values
CHECK (status IN ('', 'In Progress', 'Completed', 'Skip'));

ALTER TABLE content_items
ADD CONSTRAINT completed_skip_no_position
CHECK ((status NOT IN ('Completed', 'Skip') OR queue_position IS NULL));

ALTER TABLE content_items
ADD CONSTRAINT position_confirmed_requires_position
CHECK ((NOT position_confirmed OR queue_position IS NOT NULL));

-- Create indexes for performance
CREATE INDEX idx_content_items_queue_position
  ON content_items (queue_position)
  WHERE queue_position IS NOT NULL;

CREATE INDEX idx_content_items_status
  ON content_items (status)
  WHERE status != '';

CREATE INDEX idx_content_items_published_on
  ON content_items (published_on DESC NULLS LAST);

-- Create index for deduplication (case-insensitive title + author lookup)
CREATE INDEX idx_content_items_title_author_lower
  ON content_items (LOWER(title), LOWER(author));

-- Create auto-update trigger for updated_at
CREATE TRIGGER update_content_items_updated_at
  BEFORE UPDATE ON content_items
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Enable Row Level Security (matches queue_items policy)
ALTER TABLE content_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations with service key"
  ON content_items USING (true);

-- ============================================================================
-- TABLE CREATION: content_sources
-- ============================================================================

-- Create content_sources table (multiple rows per content item)
CREATE TABLE content_sources (
  -- Primary key
  id BIGSERIAL PRIMARY KEY,

  -- Foreign key to content_items
  content_item_id BIGINT NOT NULL,

  -- Source details
  platform TEXT NOT NULL,
  link TEXT NOT NULL,

  -- Email automation deduplication
  message_id TEXT NULL,

  -- Primary source flag (used for default display)
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,

  -- Timestamp
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Foreign key constraint (delete sources when content deleted)
  CONSTRAINT fk_content_item
    FOREIGN KEY (content_item_id)
    REFERENCES content_items (id)
    ON DELETE CASCADE
);

-- Add unique constraint (prevent exact duplicate sources)
ALTER TABLE content_sources
ADD CONSTRAINT unique_source_per_item
UNIQUE (content_item_id, platform, link);

-- Create indexes for performance
CREATE INDEX idx_content_sources_content_item_id
  ON content_sources (content_item_id);

CREATE INDEX idx_content_sources_message_id
  ON content_sources (message_id)
  WHERE message_id IS NOT NULL;

CREATE INDEX idx_content_sources_platform
  ON content_sources (platform);

-- Enable Row Level Security (matches queue_items policy)
ALTER TABLE content_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations with service key"
  ON content_sources USING (true);

-- ============================================================================
-- DATA MIGRATION
-- ============================================================================

-- Migrate data from queue_items to content_items
-- One row per queue_items row (1:1 for now, deduplication happens via API later)
INSERT INTO content_items (
  id,
  title,
  author,
  published_on,
  status,
  queue_position,
  position_confirmed,
  progress,
  created_at,
  updated_at
)
SELECT
  id,
  title,
  author,
  published_on,
  status,
  queue_position,
  position_confirmed,
  progress,
  created_at,
  updated_at
FROM queue_items;

-- Migrate platform and link to content_sources
-- Mark all initial sources as primary (is_primary = TRUE)
INSERT INTO content_sources (
  id,
  content_item_id,
  platform,
  link,
  message_id,
  is_primary,
  created_at
)
SELECT
  id,                    -- Use same ID for initial sources
  id,                    -- content_item_id = queue_items.id
  platform,
  COALESCE(link, ''),    -- Convert NULL links to empty string
  message_id,
  TRUE,                  -- All migrated sources are primary
  created_at
FROM queue_items;

-- Update sequences to match current MAX(id)
SELECT setval('content_items_id_seq', COALESCE((SELECT MAX(id) FROM content_items), 1));
SELECT setval('content_sources_id_seq', COALESCE((SELECT MAX(id) FROM content_sources), 1));

-- ============================================================================
-- DEDUPLICATION FUNCTION
-- ============================================================================

-- Function to insert or update content with deduplication
-- Returns the content_item_id (existing or new)
CREATE OR REPLACE FUNCTION insert_or_update_content(
  p_title TEXT,
  p_author TEXT,
  p_platform TEXT,
  p_link TEXT,
  p_published_on TIMESTAMPTZ DEFAULT NULL,
  p_message_id TEXT DEFAULT NULL,
  p_is_primary BOOLEAN DEFAULT FALSE
) RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_content_id BIGINT;
  v_source_exists BOOLEAN;
  v_has_primary BOOLEAN;
  v_final_is_primary BOOLEAN;
BEGIN
  -- Validate required parameters
  IF p_title IS NULL OR TRIM(p_title) = '' THEN
    RAISE EXCEPTION 'Title is required';
  END IF;
  IF p_author IS NULL OR TRIM(p_author) = '' THEN
    RAISE EXCEPTION 'Author is required';
  END IF;
  IF p_platform IS NULL OR TRIM(p_platform) = '' THEN
    RAISE EXCEPTION 'Platform is required';
  END IF;
  IF p_link IS NULL OR TRIM(p_link) = '' THEN
    RAISE EXCEPTION 'Link is required';
  END IF;

  -- Check if content already exists (case-insensitive match on title + author)
  SELECT id INTO v_content_id
  FROM content_items
  WHERE LOWER(TRIM(title)) = LOWER(TRIM(p_title))
    AND LOWER(TRIM(author)) = LOWER(TRIM(p_author))
  LIMIT 1;

  -- If content doesn't exist, create it
  IF v_content_id IS NULL THEN
    INSERT INTO content_items (title, author, published_on)
    VALUES (TRIM(p_title), TRIM(p_author), p_published_on)
    RETURNING id INTO v_content_id;

    -- First source for new content is always primary
    v_final_is_primary := TRUE;
  ELSE
    -- Content exists, check if this specific source already exists
    SELECT EXISTS(
      SELECT 1 FROM content_sources
      WHERE content_item_id = v_content_id
        AND platform = p_platform
        AND link = p_link
    ) INTO v_source_exists;

    -- If source already exists, just return the content_id
    IF v_source_exists THEN
      RETURN v_content_id;
    END IF;

    -- Check if content already has a primary source
    SELECT EXISTS(
      SELECT 1 FROM content_sources
      WHERE content_item_id = v_content_id
        AND is_primary = TRUE
    ) INTO v_has_primary;

    -- Determine if this new source should be primary
    IF p_is_primary THEN
      -- User explicitly requested primary
      v_final_is_primary := TRUE;

      -- Clear existing primary flags if setting new primary
      UPDATE content_sources
      SET is_primary = FALSE
      WHERE content_item_id = v_content_id;
    ELSIF NOT v_has_primary THEN
      -- No primary set yet, use platform priority algorithm
      -- Priority: Spotify > YouTube > Podcast > others
      v_final_is_primary := CASE
        WHEN p_platform = 'Spotify' THEN TRUE
        WHEN p_platform = 'YouTube' AND NOT EXISTS(
          SELECT 1 FROM content_sources
          WHERE content_item_id = v_content_id AND platform = 'Spotify'
        ) THEN TRUE
        WHEN p_platform = 'Podcast' AND NOT EXISTS(
          SELECT 1 FROM content_sources
          WHERE content_item_id = v_content_id AND platform IN ('Spotify', 'YouTube')
        ) THEN TRUE
        ELSE FALSE
      END;

      -- If this will be primary, clear any existing primary flags
      IF v_final_is_primary THEN
        UPDATE content_sources
        SET is_primary = FALSE
        WHERE content_item_id = v_content_id;
      END IF;
    ELSE
      -- Has primary already, this is just an alternate source
      v_final_is_primary := FALSE;
    END IF;
  END IF;

  -- Insert the new source
  INSERT INTO content_sources (
    content_item_id,
    platform,
    link,
    message_id,
    is_primary
  ) VALUES (
    v_content_id,
    p_platform,
    p_link,
    p_message_id,
    v_final_is_primary
  );

  RETURN v_content_id;
END;
$$;

-- Add comment for documentation
COMMENT ON FUNCTION insert_or_update_content IS
'Inserts or updates content with automatic deduplication.
Matches existing content by case-insensitive title + author comparison.
Returns content_item_id for existing or newly created content.
Automatically manages is_primary flag based on platform priority.';

-- ============================================================================
-- ARCHIVE OLD TABLE
-- ============================================================================

-- Rename queue_items to backup table (keep for 1 week)
ALTER TABLE queue_items RENAME TO queue_items_backup_pre_migration_005;

-- ============================================================================
-- POST-MIGRATION VERIFICATION
-- ============================================================================

-- Verify row counts match
SELECT
  (SELECT COUNT(*) FROM content_items) as content_items_count,
  (SELECT COUNT(*) FROM content_sources) as content_sources_count,
  (SELECT COUNT(*) FROM queue_items_backup_pre_migration_005) as original_count;
-- content_items_count and content_sources_count should equal original_count

-- Verify all sources marked as primary
SELECT COUNT(*) as non_primary_sources FROM content_sources WHERE is_primary = FALSE;
-- Should return 0

-- Verify constraints are enforced
SELECT constraint_name, constraint_type
FROM information_schema.table_constraints
WHERE table_name = 'content_items'
  AND constraint_name IN (
    'valid_status_values',
    'completed_skip_no_position',
    'position_confirmed_requires_position'
  );
-- Should return 3 rows

-- Verify foreign key constraint
SELECT constraint_name, constraint_type
FROM information_schema.table_constraints
WHERE table_name = 'content_sources'
  AND constraint_name = 'fk_content_item';
-- Should return 1 row

-- Verify indexes created
SELECT indexname FROM pg_indexes
WHERE tablename = 'content_items'
ORDER BY indexname;

SELECT indexname FROM pg_indexes
WHERE tablename = 'content_sources'
ORDER BY indexname;

-- Sample data check (random 5 items)
SELECT
  ci.id,
  ci.title,
  ci.author,
  ci.status,
  ci.queue_position,
  cs.platform,
  cs.link,
  cs.is_primary
FROM content_items ci
JOIN content_sources cs ON ci.id = cs.content_item_id
ORDER BY ci.id
LIMIT 5;

-- Verify deduplication function exists
SELECT routine_name, routine_type
FROM information_schema.routines
WHERE routine_name = 'insert_or_update_content';
-- Should return 1 row

-- ============================================================================
-- TEST DEDUPLICATION FUNCTION
-- ============================================================================

-- Test 1: Insert new content
DO $$
DECLARE
  v_test_id BIGINT;
BEGIN
  -- Insert test content
  v_test_id := insert_or_update_content(
    'TEST: Multi-Source Test Content',
    'TEST: Test Author',
    'Spotify',
    'https://spotify.com/test123',
    NOW(),
    'test_msg_001',
    FALSE
  );

  RAISE NOTICE 'Test 1 - New content created with ID: %', v_test_id;

  -- Verify created
  IF NOT EXISTS(SELECT 1 FROM content_items WHERE id = v_test_id) THEN
    RAISE EXCEPTION 'Test 1 FAILED: Content not created';
  END IF;

  -- Cleanup
  DELETE FROM content_items WHERE id = v_test_id;

  RAISE NOTICE 'Test 1 PASSED';
END $$;

-- Test 2: Insert duplicate content with different source
DO $$
DECLARE
  v_test_id_1 BIGINT;
  v_test_id_2 BIGINT;
  v_source_count INT;
BEGIN
  -- Insert first source
  v_test_id_1 := insert_or_update_content(
    'TEST: Duplicate Test',
    'TEST: Same Author',
    'Spotify',
    'https://spotify.com/duplicate',
    NOW(),
    'test_msg_002',
    FALSE
  );

  -- Insert second source (same title/author, different platform)
  v_test_id_2 := insert_or_update_content(
    'TEST: Duplicate Test',  -- Same title
    'TEST: Same Author',     -- Same author
    'YouTube',               -- Different platform
    'https://youtube.com/duplicate',
    NOW(),
    'test_msg_003',
    FALSE
  );

  -- Verify same content_item_id returned
  IF v_test_id_1 != v_test_id_2 THEN
    RAISE EXCEPTION 'Test 2 FAILED: Different IDs returned (% vs %)', v_test_id_1, v_test_id_2;
  END IF;

  -- Verify two sources created
  SELECT COUNT(*) INTO v_source_count
  FROM content_sources
  WHERE content_item_id = v_test_id_1;

  IF v_source_count != 2 THEN
    RAISE EXCEPTION 'Test 2 FAILED: Expected 2 sources, found %', v_source_count;
  END IF;

  RAISE NOTICE 'Test 2 - Deduplication working: Same content_item_id (%) for both sources', v_test_id_1;

  -- Cleanup
  DELETE FROM content_items WHERE id = v_test_id_1;

  RAISE NOTICE 'Test 2 PASSED';
END $$;

-- Test 3: Case-insensitive matching
DO $$
DECLARE
  v_test_id_1 BIGINT;
  v_test_id_2 BIGINT;
BEGIN
  -- Insert with lowercase
  v_test_id_1 := insert_or_update_content(
    'test case sensitivity',
    'test author',
    'Web',
    'https://example.com/1',
    NOW(),
    NULL,
    FALSE
  );

  -- Insert with uppercase (should match)
  v_test_id_2 := insert_or_update_content(
    'TEST CASE SENSITIVITY',  -- Different case
    'TEST AUTHOR',            -- Different case
    'Podcast',
    'https://example.com/2',
    NOW(),
    NULL,
    FALSE
  );

  IF v_test_id_1 != v_test_id_2 THEN
    RAISE EXCEPTION 'Test 3 FAILED: Case-insensitive matching not working';
  END IF;

  RAISE NOTICE 'Test 3 - Case-insensitive matching works';

  -- Cleanup
  DELETE FROM content_items WHERE id = v_test_id_1;

  RAISE NOTICE 'Test 3 PASSED';
END $$;

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE 'All deduplication tests PASSED';
  RAISE NOTICE 'Migration 005 completed successfully!';
  RAISE NOTICE 'Next steps:';
  RAISE NOTICE '1. Monitor application for 24 hours';
  RAISE NOTICE '2. Update API layer to query new schema';
  RAISE NOTICE '3. After 1 week: DROP TABLE queue_items_backup_pre_migration_005';
END $$;
