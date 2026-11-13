-- Migration: Add sync_progress RPC function
-- Description: RPC for Tasklet (and future Vercel cron) to sync progress from external platforms
-- Date: 2025-12-14
-- Related: Progress Sync feature (GitHub Issue #4)

-- sync_progress: Batch update progress for items from external platforms
--
-- Parameters:
--   p_source: Platform identifier ('spotify', 'audible', 'substack', 'elevenreader')
--   p_items: JSONB array of items to sync, each with:
--     - title (required): Content title
--     - author (required): Content author/creator
--     - external_id (optional): Platform-specific ID (e.g., 'spotify:episode:xxx')
--     - progress (optional): Progress percentage as string (e.g., '65')
--     - status (optional): 'In Progress' or 'Completed'
--
-- Returns: JSONB object with sync results
--   - sync_log_id: ID of the sync_logs entry for debugging
--   - processed: Number of items processed
--   - updated: Number of items updated (found match)
--   - skipped: Number of items skipped (no match or invalid)
--
-- Matching logic:
--   1. Try external_id match in content_sources
--   2. Fall back to case-insensitive title + author match in content_items
--   3. Skip if no match found (intentional for Spotify to avoid queue pollution)

CREATE OR REPLACE FUNCTION sync_progress(
  p_source TEXT,
  p_items JSONB
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_sync_log_id BIGINT;
  v_item JSONB;
  v_content_id BIGINT;
  v_title TEXT;
  v_author TEXT;
  v_external_id TEXT;
  v_progress TEXT;
  v_status TEXT;
  v_processed INT := 0;
  v_updated INT := 0;
  v_skipped INT := 0;
BEGIN
  -- Validate source
  IF p_source IS NULL OR p_source NOT IN ('spotify', 'audible', 'substack', 'elevenreader') THEN
    RAISE EXCEPTION 'Invalid source. Must be one of: spotify, audible, substack, elevenreader';
  END IF;

  -- Validate items is an array
  IF p_items IS NULL OR jsonb_typeof(p_items) != 'array' THEN
    RAISE EXCEPTION 'Items must be a JSON array';
  END IF;

  -- Create sync log entry
  INSERT INTO sync_logs (source, status, items_processed, items_updated, items_skipped)
  VALUES (p_source, 'running', 0, 0, 0)
  RETURNING id INTO v_sync_log_id;

  -- Process each item
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    -- Extract fields
    v_title := v_item->>'title';
    v_author := v_item->>'author';
    v_external_id := v_item->>'external_id';
    v_progress := v_item->>'progress';
    v_status := v_item->>'status';

    -- Skip items without required fields
    IF v_title IS NULL OR TRIM(v_title) = '' OR v_author IS NULL OR TRIM(v_author) = '' THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- Validate status if provided
    IF v_status IS NOT NULL AND v_status NOT IN ('In Progress', 'Completed') THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_content_id := NULL;

    -- Strategy 1: Match by external_id
    IF v_external_id IS NOT NULL AND TRIM(v_external_id) != '' THEN
      SELECT content_item_id INTO v_content_id
      FROM content_sources
      WHERE external_id = v_external_id
      LIMIT 1;
    END IF;

    -- Strategy 2: Fall back to title + author match
    IF v_content_id IS NULL THEN
      SELECT id INTO v_content_id
      FROM content_items
      WHERE LOWER(TRIM(title)) = LOWER(TRIM(v_title))
        AND LOWER(TRIM(author)) = LOWER(TRIM(v_author))
      LIMIT 1;
    END IF;

    -- Update if match found
    IF v_content_id IS NOT NULL THEN
      UPDATE content_items
      SET
        progress = COALESCE(v_progress, progress),
        status = COALESCE(v_status, status),
        updated_at = NOW()
      WHERE id = v_content_id;

      v_updated := v_updated + 1;
    ELSE
      v_skipped := v_skipped + 1;
    END IF;

    v_processed := v_processed + 1;
  END LOOP;

  -- Update sync log with results
  UPDATE sync_logs
  SET
    status = 'success',
    completed_at = NOW(),
    items_processed = v_processed,
    items_updated = v_updated,
    items_skipped = v_skipped
  WHERE id = v_sync_log_id;

  -- Return results
  RETURN jsonb_build_object(
    'sync_log_id', v_sync_log_id,
    'processed', v_processed,
    'updated', v_updated,
    'skipped', v_skipped
  );

EXCEPTION WHEN OTHERS THEN
  -- Update sync log with error
  IF v_sync_log_id IS NOT NULL THEN
    UPDATE sync_logs
    SET
      status = 'error',
      completed_at = NOW(),
      error_message = SQLERRM,
      items_processed = v_processed,
      items_updated = v_updated,
      items_skipped = v_skipped
    WHERE id = v_sync_log_id;
  END IF;

  RAISE;
END;
$$;

COMMENT ON FUNCTION sync_progress(TEXT, JSONB) IS
'Batch sync progress updates from external platforms (Spotify, Audible, Substack, ElevenReader).

Matches items by external_id first, then falls back to case-insensitive title+author.
Only updates existing content - does not create new items (intentional to avoid queue pollution).

Example call:
  SELECT sync_progress(
    ''spotify'',
    ''[
      {"title": "Episode Name", "author": "Podcast Name", "external_id": "spotify:episode:xxx", "progress": "65", "status": "In Progress"},
      {"title": "Another Episode", "author": "Another Podcast", "progress": "100", "status": "Completed"}
    ]''::jsonb
  );

Returns: {"sync_log_id": 123, "processed": 2, "updated": 1, "skipped": 1}';

-- Grant permissions
GRANT EXECUTE ON FUNCTION sync_progress(TEXT, JSONB) TO anon;
GRANT EXECUTE ON FUNCTION sync_progress(TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION sync_progress(TEXT, JSONB) TO service_role;

-- POST-MIGRATION VERIFICATION
DO $$
DECLARE
  v_result JSONB;
BEGIN
  -- Test with empty array (should succeed with 0 counts)
  SELECT sync_progress('spotify', '[]'::jsonb) INTO v_result;

  IF v_result->>'processed' != '0' THEN
    RAISE EXCEPTION 'Expected 0 processed, got %', v_result->>'processed';
  END IF;

  -- Clean up test sync log
  DELETE FROM sync_logs WHERE id = (v_result->>'sync_log_id')::bigint;

  RAISE NOTICE 'Migration completed successfully: sync_progress RPC created';
END $$;
