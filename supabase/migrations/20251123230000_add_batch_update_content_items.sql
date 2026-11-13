-- Migration: Add batch_update_content_items function
-- Description: Batch update multiple content items in a single transaction
-- Date: 2025-11-23

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
      )
    WHERE id = item_id;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.batch_update_content_items(jsonb) IS
'Batch update multiple content items in single transaction for performance.
Accepts JSONB array of updates with optional fields: status, queue_position, position_confirmed.
Used by handleMakeNext to reduce 15-20+ requests to 1 request.';

-- Grant permissions
GRANT EXECUTE ON FUNCTION public.batch_update_content_items(jsonb) TO anon;
GRANT EXECUTE ON FUNCTION public.batch_update_content_items(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.batch_update_content_items(jsonb) TO service_role;
