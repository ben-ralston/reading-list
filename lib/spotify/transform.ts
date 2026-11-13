/**
 * Transform Spotify API responses to sync format
 *
 * Handles progress calculation, status determination, and
 * show name normalization for matching.
 */

import type { SavedEpisode } from './client'
import type { SyncItem } from '@/lib/sync/matching'

/**
 * Calculate progress percentage from resume point and duration.
 *
 * @param resumePositionMs - Current position in milliseconds
 * @param durationMs - Total duration in milliseconds
 * @returns Progress as integer 0-100
 */
export function calculateProgress(resumePositionMs: number, durationMs: number): number {
  if (durationMs <= 0) return 0
  const progress = (resumePositionMs / durationMs) * 100
  return Math.round(Math.min(100, Math.max(0, progress)))
}

/**
 * Determine status based on progress and fully_played flag.
 *
 * @param progress - Progress percentage (0-100)
 * @param fullyPlayed - Spotify's fully_played flag
 * @returns Status string for database (empty string for no progress)
 */
/** Percentage threshold at which an episode is considered completed */
const COMPLETION_THRESHOLD_PERCENT = 95
/** Remaining playtime at/below which an episode counts as completed (outro/credits). */
const COMPLETION_REMAINING_MS = 120_000
/** Near-end rule floor: never complete a barely-started short episode. */
const COMPLETION_REMAINING_MIN_PERCENT = 80

export function determineStatus(
  progress: number,
  fullyPlayed: boolean,
  remainingMs?: number
): '' | 'In Progress' | 'Completed' {
  // Treat as completed if fully_played is set, progress reaches the threshold,
  // or the resume point sits within the last two minutes (stopping before the
  // outro used to strand episodes as In Progress forever). The 80% floor keeps
  // a short episode with 2 minutes left at 40% from being falsely completed.
  if (fullyPlayed || progress >= COMPLETION_THRESHOLD_PERCENT) {
    return 'Completed'
  }
  if (
    remainingMs !== undefined &&
    remainingMs <= COMPLETION_REMAINING_MS &&
    progress >= COMPLETION_REMAINING_MIN_PERCENT
  ) {
    return 'Completed'
  }
  // Trivial progress (1% or less) = empty status (like email imports)
  if (progress <= 1) {
    return ''
  }
  return 'In Progress'
}

/**
 * Normalize show name for better matching.
 * Strips common suffixes like "Podcast", "Show", etc.
 *
 * @param name - Raw show name from Spotify
 * @returns Normalized name for matching
 */
// Sentinel returned by normalizeShowName when a show name is absent. It is a
// placeholder for matching, never a real label — spotifyShowLabel maps it to null.
export const UNKNOWN_SHOW_NAME = 'Unknown Show'

export function normalizeShowName(name: string | null | undefined): string {
  // Handle null/undefined show names (can happen with some Spotify episodes)
  if (!name) {
    return UNKNOWN_SHOW_NAME
  }

  // Remove common podcast suffixes (case-insensitive)
  // Order matters: longer matches first
  const suffixes = [
    ' - The Podcast',
    ' The Podcast',
    ' Podcast',
    ' - The Show',
    ' The Show',
    ' Show',
    ' Audio',
  ]

  let normalized = name.trim()

  for (const suffix of suffixes) {
    if (normalized.toLowerCase().endsWith(suffix.toLowerCase())) {
      normalized = normalized.slice(0, -suffix.length).trim()
      break // Only remove one suffix
    }
  }

  return normalized
}

/**
 * Show name to persist as a content_sources.source_label (#245), or null.
 *
 * Takes an already-normalized show name (as carried on SyncItem.author) and
 * nulls out anything that isn't a real label — the UNKNOWN_SHOW_NAME sentinel,
 * empty, or whitespace-only — so the UI never renders a placeholder as a label.
 */
export function spotifyShowLabel(showName: string | null | undefined): string | null {
  const trimmed = showName?.trim() ?? ''
  if (!trimmed || trimmed === UNKNOWN_SHOW_NAME) return null
  return trimmed
}

/**
 * Convert Spotify date string to noon UTC ISO timestamp.
 *
 * Spotify returns dates in three formats:
 * - YYYY-MM-DD (full date)
 * - YYYY-MM (month precision)
 * - YYYY (year precision)
 *
 * We store at noon UTC (12:00:00Z) to ensure correct date display
 * in all timezones (UTC-12 to UTC+12). Without this, midnight UTC
 * dates appear as the previous day in US timezones.
 *
 * @param releaseDate - Date string from Spotify API
 * @returns ISO timestamp at noon UTC, or undefined for invalid dates
 */
export function normalizeSpotifyDate(releaseDate: string | null | undefined): string | undefined {
  // Skip null, undefined, or invalid dates like "0000"
  if (!releaseDate || releaseDate === '0000' || releaseDate.startsWith('0000')) {
    return undefined
  }

  let dateStr: string

  if (/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) {
    // YYYY-MM-DD format - use as-is
    dateStr = releaseDate
  } else if (/^\d{4}-\d{2}$/.test(releaseDate)) {
    // YYYY-MM format - default to first of month
    dateStr = `${releaseDate}-01`
  } else if (/^\d{4}$/.test(releaseDate)) {
    // YYYY format - default to January 1st
    dateStr = `${releaseDate}-01-01`
  } else {
    // Unknown format - skip
    return undefined
  }

  // Return as noon UTC ISO timestamp
  return `${dateStr}T12:00:00Z`
}

/**
 * Check if an episode has meaningful progress to sync.
 *
 * @param saved - Saved episode from Spotify
 * @returns Whether this episode should be included in sync
 */
export function hasProgress(saved: SavedEpisode): boolean {
  // resume_point is inside the episode object
  const resumePoint = saved.episode.resume_point
  if (!resumePoint) {
    return false
  }
  return (
    resumePoint.fully_played ||
    resumePoint.resume_position_ms > 0
  )
}

/**
 * Transform Spotify saved episodes to sync item format.
 * Includes ALL saved episodes, not just those with progress.
 *
 * @param episodes - Raw saved episodes from Spotify API
 * @returns Array of sync items ready for /api/sync
 */
export function transformToSyncItems(episodes: SavedEpisode[]): SyncItem[] {
  // Filter out unavailable episodes (deleted/region-restricted content from Spotify)
  const validEpisodes = episodes.filter((saved) => saved.episode?.name != null)
  const skippedCount = episodes.length - validEpisodes.length

  if (skippedCount > 0) {
    console.log(`[Spotify Transform] Skipped ${skippedCount} unavailable episode(s) (deleted/restricted content)`)
  }

  return validEpisodes.map((saved) => {
      const { episode } = saved
      const resumePoint = episode.resume_point

      // Handle missing resume_point (episode never played)
      const resumePositionMs = resumePoint?.resume_position_ms ?? 0
      const fullyPlayed = resumePoint?.fully_played ?? false

      const progress = calculateProgress(resumePositionMs, episode.duration_ms)
      // Remaining playtime only means something once playback started —
      // an unplayed episode's full duration must not trip the near-end rule.
      const remainingMs =
        resumePositionMs > 0 ? Math.max(0, episode.duration_ms - resumePositionMs) : undefined
      const status = determineStatus(progress, fullyPlayed, remainingMs)

      // Convert Spotify date to noon UTC for correct timezone display
      const publishedOn = normalizeSpotifyDate(episode.release_date)

      return {
        title: episode.name,
        author: normalizeShowName(episode.show?.name),
        platform: 'Spotify',
        link: episode.external_urls?.spotify,
        // Only set progress if there's meaningful status (not trivial progress)
        progress: status ? progress.toString() : undefined,
        // Empty status maps to undefined in SyncItem (existing pattern)
        status: status || undefined,
        externalId: `spotify:episode:${episode.id}`,
        publishedOn,
        // Feed-card enrichment (#167): episode art + duration for the listen
        // estimate. Both come from the episode object already fetched.
        imageUrl: episode.images?.[0]?.url ?? null,
        durationSeconds: Math.round(episode.duration_ms / 1000),
        // When the episode landed in saved episodes — the back-catalog guard
        // compares it to publishedOn (#305).
        savedAt: saved.added_at,
      }
    })
}
