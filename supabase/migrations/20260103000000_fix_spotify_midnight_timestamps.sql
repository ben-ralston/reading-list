-- Migration: Fix Spotify midnight UTC timestamps
-- Description: Shift Spotify items from midnight UTC to noon UTC for correct timezone display
-- Date: 2026-01-03
--
-- Problem: Spotify API returns date-only strings (YYYY-MM-DD) that become midnight UTC
-- when stored in TIMESTAMPTZ. This causes dates to display as the previous day in US
-- timezones when converted via toLocaleDateString().
--
-- Solution: Add 12 hours to shift midnight UTC (00:00:00Z) to noon UTC (12:00:00Z).
-- This ensures correct date display in all timezones from UTC-12 to UTC+12.
--
-- Scope: Only affects items with Spotify sources that have exactly midnight timestamps.
-- Items with non-midnight timestamps are left unchanged (may have been manually corrected).

-- ============================================================================
-- Update timestamps from midnight to noon UTC for Spotify items
-- ============================================================================

UPDATE content_items ci
SET published_on = ci.published_on + INTERVAL '12 hours'
WHERE ci.id IN (
  -- Select content items that have a Spotify source
  SELECT DISTINCT cs.content_item_id
  FROM content_sources cs
  WHERE cs.platform = 'Spotify'
)
AND ci.published_on IS NOT NULL
-- Only update if currently at midnight (00:00:00)
AND EXTRACT(HOUR FROM ci.published_on) = 0
AND EXTRACT(MINUTE FROM ci.published_on) = 0
AND EXTRACT(SECOND FROM ci.published_on) = 0;
