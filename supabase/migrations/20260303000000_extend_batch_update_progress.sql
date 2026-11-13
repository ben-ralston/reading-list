-- Migration: Extend batch_update_content_items with progress and status_changed_at
-- Description: Add progress and status_changed_at fields to the batch update RPC
--              so Spotify sync can batch all progress updates into a single call.
-- Date: 2026-03-03

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
      progress = COALESCE(
        CASE WHEN update_item ? 'progress'
          THEN (update_item->>'progress')::text
          ELSE NULL
        END,
        progress
      ),
      status_changed_at = CASE
        WHEN update_item ? 'status_changed_at' THEN
          CASE
            WHEN update_item->>'status_changed_at' = 'null' THEN NULL
            ELSE (update_item->>'status_changed_at')::timestamptz
          END
        ELSE status_changed_at
      END
    WHERE id = item_id;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.batch_update_content_items(jsonb) IS
'Batch update multiple content items in single transaction for performance.
Accepts JSONB array of updates with optional fields: status, queue_position,
position_confirmed, progress, status_changed_at.
Used by handleMakeNext and Spotify sync to reduce many requests to 1 request.';
