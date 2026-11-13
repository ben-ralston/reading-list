-- Add status_changed_at column to track when status was last changed
ALTER TABLE content_items
ADD COLUMN status_changed_at TIMESTAMPTZ;

-- Backfill existing completed/skipped items with updated_at as best approximation
UPDATE content_items
SET status_changed_at = updated_at
WHERE status IN ('Completed', 'Skip');

-- Add comment explaining the column
COMMENT ON COLUMN content_items.status_changed_at IS 'Timestamp when status was last changed (completed, skipped, etc.)';

-- Update batch_update_content_items function to support status_changed_at
CREATE OR REPLACE FUNCTION public.batch_update_content_items(updates jsonb)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  update_item jsonb;
  item_id integer;
BEGIN
  -- Iterate through each update in the array
  FOR update_item IN SELECT * FROM jsonb_array_elements(updates)
  LOOP
    -- Extract ID
    item_id := (update_item->>'id')::integer;

    -- Build and execute dynamic UPDATE statement based on provided fields
    -- This allows partial updates (only update fields that are present in JSON)
    UPDATE content_items
    SET
      status = COALESCE(
        CASE WHEN update_item ? 'status'
          THEN (update_item->>'status')::text
          ELSE NULL
        END,
        status
      ),
      queue_position = CASE
        WHEN update_item ? 'queue_position' THEN
          CASE
            WHEN update_item->>'queue_position' = 'null' THEN NULL
            ELSE (update_item->>'queue_position')::integer
          END
        ELSE queue_position
      END,
      position_confirmed = COALESCE(
        CASE WHEN update_item ? 'position_confirmed'
          THEN (update_item->>'position_confirmed')::boolean
          ELSE NULL
        END,
        position_confirmed
      ),
      status_changed_at = COALESCE(
        CASE WHEN update_item ? 'status_changed_at'
          THEN (update_item->>'status_changed_at')::timestamptz
          ELSE NULL
        END,
        status_changed_at
      )
    WHERE id = item_id;
  END LOOP;
END;
$$;
