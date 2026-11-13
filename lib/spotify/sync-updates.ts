/** Spotify duration and per-source progress enrichment helpers.
 * Item status/high-water merging lives in apply_spotify_progress (#266). */

/**
 * Build a duration_seconds fill for one matched episode, or null when there is
 * nothing to write. duration_seconds is #167 INSERT-only enrichment, so items
 * created before it never got one; the hourly sync sees every episode's
 * duration and may fill a missing value, but must never overwrite an existing
 * one (#194).
 */
export function buildDurationFill(
  contentItemId: number,
  newDurationSeconds: number | null | undefined,
  currentDurationSeconds: number | null
): { id: number; duration_seconds: number } | null {
  if (currentDurationSeconds != null) return null
  if (!newDurationSeconds || newDurationSeconds <= 0) return null
  return { id: contentItemId, duration_seconds: newDurationSeconds }
}

/**
 * Build a per-source progress write for a matched item's Spotify source
 * (#194), or null when there is nothing to write: no cached source row, no
 * incoming progress, or the stored value already matches (most episodes
 * don't move hour-to-hour — skipping unchanged values avoids rewriting
 * every row on every cron run). Unlike the item-level high-water mark,
 * regressions DO write: the column mirrors Spotify's own last-reported
 * position, and "Spotify is behind the read position" is exactly what the
 * resume gate needs to detect.
 */
export function buildSourceProgressFill(
  cachedSource: { id: number; progress: number | null } | null,
  normalizedProgress: string | null
): { sourceId: number; progress: number } | null {
  if (!cachedSource || normalizedProgress === null) return null
  const progress = parseInt(normalizedProgress, 10)
  if (!Number.isFinite(progress)) return null
  if (cachedSource.progress === progress) return null
  return { sourceId: cachedSource.id, progress }
}
