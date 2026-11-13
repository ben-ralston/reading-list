-- Add processing tracking columns to feedback table
-- Issue: #31
--
-- These columns track which feedback entries have been processed by automation:
-- - processed: Boolean flag indicating if feedback was handled
-- - processed_at: Timestamp when processing occurred
-- - processing_notes: Text describing what actions were taken

ALTER TABLE feedback
ADD COLUMN processed BOOLEAN DEFAULT FALSE,
ADD COLUMN processed_at TIMESTAMPTZ,
ADD COLUMN processing_notes TEXT;

-- Add partial index for efficient querying of unprocessed feedback
-- This optimizes the common query pattern: WHERE processed = FALSE
CREATE INDEX idx_feedback_processed ON feedback(processed) WHERE processed = FALSE;

-- Verification
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'feedback' AND column_name = 'processed'
  ) THEN
    RAISE EXCEPTION 'Migration failed: processed column not added';
  END IF;
END $$;
