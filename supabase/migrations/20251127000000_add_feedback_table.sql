-- Migration: Add Feedback Table
-- Description: Creates a feedback table for collecting user feedback on AI queue suggestions
-- Date: 2025-11-27

-- ============================================================================
-- TABLE CREATION: feedback
-- ============================================================================

CREATE TABLE feedback (
  -- Primary key
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Foreign key to content_items (optional - feedback might be general)
  content_item_id BIGINT REFERENCES content_items(id) ON DELETE CASCADE,

  -- Feedback content
  feedback_text TEXT NOT NULL,

  -- Timestamp
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create index for querying feedback by content item
CREATE INDEX idx_feedback_content_item_id
  ON feedback (content_item_id)
  WHERE content_item_id IS NOT NULL;

-- Create index for querying feedback by creation time
CREATE INDEX idx_feedback_created_at
  ON feedback (created_at DESC);

-- Enable Row Level Security (matches other tables)
ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations with service key"
  ON feedback USING (true);

-- Add comment for documentation
COMMENT ON TABLE feedback IS 'Stores user feedback on AI queue suggestions';

-- ============================================================================
-- VERIFICATION
-- ============================================================================

-- Verify table created
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_name = 'feedback'
ORDER BY ordinal_position;

-- Verify foreign key constraint
SELECT constraint_name, constraint_type
FROM information_schema.table_constraints
WHERE table_name = 'feedback';

DO $$
BEGIN
  RAISE NOTICE 'Feedback table migration completed successfully!';
END $$;
