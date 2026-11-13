-- Migration: Add author suffix matching to insert_or_update_content
-- Description: Try matching with common podcast suffixes when exact author match fails
-- Date: 2025-12-30
--
-- Problem: Spotify normalizes "Dwarkesh Podcast" → "Dwarkesh", but Tasklet may have
-- stored the original name. This causes duplicates when the exact match fails.
--
-- Solution: If exact title+author match fails, try:
-- 1. Appending common suffixes like " Podcast", " Show", " Audio"
-- 2. Checking author aliases (e.g., "Zvi Mowshowitz" = "Don't Worry About the Vase")

-- Clean up old function overloads (PostgreSQL creates new functions when signature changes)
-- Drop all old signatures to avoid function overloading confusion
DROP FUNCTION IF EXISTS insert_or_update_content(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS insert_or_update_content(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, BIGINT, BOOLEAN);
DROP FUNCTION IF EXISTS insert_or_update_content(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, BIGINT, BOOLEAN, TEXT);
DROP FUNCTION IF EXISTS insert_or_update_content(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, BIGINT, BOOLEAN, TEXT, TEXT);

-- Helper function to get all aliases for an author
CREATE OR REPLACE FUNCTION get_author_aliases(p_author TEXT)
RETURNS TEXT[]
LANGUAGE plpgsql
IMMUTABLE
AS $func$
DECLARE
  v_normalized TEXT := LOWER(TRIM(p_author));
  -- Define alias groups - authors in the same group are considered equivalent
  v_alias_groups TEXT[][] := ARRAY[
    ARRAY['zvi mowshowitz', 'don''t worry about the vase', 'don''t worry about the vase podcast']
  ];
  v_group TEXT[];
  v_alias TEXT;
BEGIN
  -- Check each alias group
  FOREACH v_group SLICE 1 IN ARRAY v_alias_groups
  LOOP
    -- If the author is in this group, return all aliases
    FOREACH v_alias IN ARRAY v_group
    LOOP
      IF v_normalized = v_alias THEN
        RETURN v_group;
      END IF;
    END LOOP;
  END LOOP;

  -- No aliases found, return empty array
  RETURN ARRAY[]::TEXT[];
END;
$func$;

COMMENT ON FUNCTION get_author_aliases(TEXT) IS
'Returns all known aliases for an author name. Used to match content across
different naming conventions (e.g., author name vs podcast name).';

-- Replace the existing function with suffix and alias matching support
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
  p_external_id TEXT DEFAULT NULL,
  p_added_by TEXT DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_content_id BIGINT;
  v_source_exists BOOLEAN;
  v_has_primary BOOLEAN;
  v_final_is_primary BOOLEAN;
  v_is_new_content BOOLEAN := FALSE;
  v_suffix TEXT;
  v_alias TEXT;
  v_suffixes TEXT[] := ARRAY[
    ' Podcast',
    ' The Podcast',
    ' - The Podcast',
    ' Show',
    ' The Show',
    ' - The Show',
    ' Audio'
  ];
  v_aliases TEXT[];
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

  -- Strategy 1: Check if content already exists (exact case-insensitive match on title + author)
  SELECT id INTO v_content_id
  FROM content_items
  WHERE LOWER(TRIM(title)) = LOWER(TRIM(p_title))
    AND LOWER(TRIM(author)) = LOWER(TRIM(p_author))
  LIMIT 1;

  -- Strategy 2: If no exact match, try with common author suffixes appended
  -- This handles normalized names like "Dwarkesh" matching "Dwarkesh Podcast"
  IF v_content_id IS NULL THEN
    FOREACH v_suffix IN ARRAY v_suffixes
    LOOP
      SELECT id INTO v_content_id
      FROM content_items
      WHERE LOWER(TRIM(title)) = LOWER(TRIM(p_title))
        AND LOWER(TRIM(author)) = LOWER(TRIM(p_author) || v_suffix)
      LIMIT 1;

      EXIT WHEN v_content_id IS NOT NULL;
    END LOOP;
  END IF;

  -- Strategy 3: If still no match, try author aliases
  -- This handles cases like "Zvi Mowshowitz" = "Don't Worry About the Vase"
  IF v_content_id IS NULL THEN
    v_aliases := get_author_aliases(p_author);
    IF array_length(v_aliases, 1) > 0 THEN
      SELECT id INTO v_content_id
      FROM content_items
      WHERE LOWER(TRIM(title)) = LOWER(TRIM(p_title))
        AND LOWER(TRIM(author)) = ANY(v_aliases)
      LIMIT 1;
    END IF;
  END IF;

  -- If content doesn't exist, create it
  IF v_content_id IS NULL THEN
    v_is_new_content := TRUE;

    INSERT INTO content_items (
      title,
      author,
      published_on,
      queue_position,
      position_confirmed,
      added_by
    )
    VALUES (
      TRIM(p_title),
      TRIM(p_author),
      p_published_on,
      p_queue_position,
      p_position_confirmed,
      p_added_by
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

  -- Insert the new source
  INSERT INTO content_sources (
    content_item_id,
    platform,
    link,
    message_id,
    is_primary,
    external_id
  )
  VALUES (
    v_content_id,
    p_platform,
    p_link,
    p_message_id,
    v_final_is_primary,
    p_external_id
  );

  RETURN v_content_id;
END;
$$;

COMMENT ON FUNCTION insert_or_update_content(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, BIGINT, BOOLEAN, TEXT, TEXT) IS
'Insert or update content with deduplication and multi-source support.

Matching strategy (in order):
1. Exact title + author match (case-insensitive)
2. Title + author with common suffixes (" Podcast", " Show", etc.)
3. Title + author aliases (e.g., "Zvi Mowshowitz" = "Don''t Worry About the Vase")

For new content, sets queue_position and position_confirmed if provided.
For existing content, only adds a new source.
Returns the content_item ID.

Parameters:
- p_title, p_author: Required content identification
- p_platform, p_link: Required source information
- p_published_on: Optional publication date
- p_message_id: Optional email message ID for deduplication
- p_is_primary: Force this source as primary (default false)
- p_queue_position: Queue position (only set for NEW content)
- p_position_confirmed: Whether position is confirmed (only set for NEW content)
- p_external_id: Optional external ID (e.g., spotify:episode:xxx)
- p_added_by: Optional source identifier (e.g., spotify, tasklet)';

-- Grant permissions for helper function
GRANT EXECUTE ON FUNCTION get_author_aliases(TEXT) TO anon;
GRANT EXECUTE ON FUNCTION get_author_aliases(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION get_author_aliases(TEXT) TO service_role;

-- Grant permissions for main function
GRANT EXECUTE ON FUNCTION insert_or_update_content(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, BIGINT, BOOLEAN, TEXT, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION insert_or_update_content(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, BIGINT, BOOLEAN, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION insert_or_update_content(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, BIGINT, BOOLEAN, TEXT, TEXT) TO service_role;
