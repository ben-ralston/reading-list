-- Migration: Extend insert_or_update_content function with external_id parameter
-- Description: Add external_id parameter for platform-specific identifiers used by progress sync
-- Date: 2025-11-29
-- Related: Progress Sync feature (GitHub Issue #4)

-- Replace the existing function with extended version that includes external_id
CREATE OR REPLACE FUNCTION insert_or_update_content(
  p_title TEXT,
  p_author TEXT,
  p_platform TEXT,
  p_link TEXT,
  p_published_on TIMESTAMPTZ DEFAULT NULL,
  p_message_id TEXT DEFAULT NULL,
  p_is_primary BOOLEAN DEFAULT FALSE,
  p_queue_position BIGINT DEFAULT NULL,
  p_position_confirmed BOOLEAN DEFAULT FALSE,
  p_external_id TEXT DEFAULT NULL  -- NEW: Platform-specific identifier (e.g., spotify:episode:xxx)
) RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_content_id BIGINT;
  v_source_exists BOOLEAN;
  v_has_primary BOOLEAN;
  v_final_is_primary BOOLEAN;
  v_is_new_content BOOLEAN := FALSE;
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
    v_is_new_content := TRUE;

    INSERT INTO content_items (
      title,
      author,
      published_on,
      queue_position,
      position_confirmed
    )
    VALUES (
      TRIM(p_title),
      TRIM(p_author),
      p_published_on,
      p_queue_position,
      p_position_confirmed
    )
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
        WHEN p_platform = 'YouTube' THEN TRUE
        WHEN p_platform = 'Podcast' THEN TRUE
        ELSE FALSE
      END;
    ELSE
      -- Has primary, don't override unless explicitly requested
      v_final_is_primary := FALSE;
    END IF;
  END IF;

  -- Insert the new source with external_id
  INSERT INTO content_sources (
    content_item_id,
    platform,
    link,
    message_id,
    is_primary,
    external_id  -- NEW: Include external_id
  )
  VALUES (
    v_content_id,
    p_platform,
    p_link,
    p_message_id,
    v_final_is_primary,
    p_external_id  -- NEW: Include external_id value
  );

  RETURN v_content_id;
END;
$$;

COMMENT ON FUNCTION insert_or_update_content(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, BIGINT, BOOLEAN, TEXT) IS
'Insert or update content with deduplication and multi-source support.
Deduplicates by title+author (case-insensitive). For new content, sets queue_position
and position_confirmed if provided. For existing content, only adds a new source.
Returns the content_item ID.

Parameters:
- p_title, p_author: Required content identification
- p_platform, p_link: Required source information
- p_published_on: Optional publication date
- p_message_id: Optional email message ID for deduplication
- p_is_primary: Force this source as primary (default false)
- p_queue_position: Queue position (only set for NEW content)
- p_position_confirmed: Whether position is confirmed (only set for NEW content)
- p_external_id: Platform-specific identifier for matching (e.g., spotify:episode:xxx)';

-- Grant permissions for all function signatures
GRANT EXECUTE ON FUNCTION insert_or_update_content(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, BIGINT, BOOLEAN, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION insert_or_update_content(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, BIGINT, BOOLEAN, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION insert_or_update_content(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, BIGINT, BOOLEAN, TEXT) TO service_role;

-- POST-MIGRATION VERIFICATION
DO $$
DECLARE
  v_test_id BIGINT;
BEGIN
  -- Test the function with external_id parameter
  -- This will fail silently in production but validates the function signature exists
  BEGIN
    -- Quick signature check - try to call with all parameters including external_id
    -- Using a transaction that we'll roll back
    SELECT insert_or_update_content(
      'Test Title for Migration Verification',
      'Test Author',
      'Spotify',
      'https://test.example.com/verify-migration',
      NULL,
      NULL,
      FALSE,
      NULL,
      FALSE,
      'spotify:episode:test123'  -- external_id
    ) INTO v_test_id;

    -- Clean up test data
    DELETE FROM content_sources WHERE content_item_id = v_test_id;
    DELETE FROM content_items WHERE id = v_test_id;

    RAISE NOTICE 'Migration completed successfully: insert_or_update_content extended with external_id parameter';
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Function signature test failed: %', SQLERRM;
  END;
END $$;
