-- Add AI summary columns to content_items
ALTER TABLE content_items ADD COLUMN summary TEXT;
ALTER TABLE content_items ADD COLUMN summary_generated_at TIMESTAMPTZ;
