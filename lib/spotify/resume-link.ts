/**
 * Resume-on-Spotify link builder (#194).
 *
 * The Substack→Spotify half of the position handoff: a dual-source item (a
 * Substack post plus its Spotify AI-voiced/companion episode on the same
 * content_item) carries a per-source last-seen progress percent for each
 * platform. The gate compares the harvested read position (from the text
 * source) against Spotify's own last-seen position and only offers to seek
 * Spotify when the read position is meaningfully ahead. Mapping the read
 * position onto the episode's duration gives a seek target that
 * https://open.spotify.com/episode/<id>?t=<seconds> honors on desktop and iOS.
 * (The spotify: URI scheme ignores time offsets — only the https URL seeks.)
 *
 * The mapping is deliberately crude (read% ≈ listen%); the ~ in the label
 * keeps that transparent. Spotify-only items are excluded: Spotify already
 * resumes those natively at its own resume point. When Spotify's own
 * position is within RESUME_MARGIN_PERCENT of the read position, native
 * resume is at least as good, so the action stays hidden.
 */

import type { QueueItem } from '@/lib/queue-client'
import { AUDIO_PLATFORMS } from '@/lib/media-type'

const EPISODE_PREFIX = 'spotify:episode:'

// Minimum lead (percentage points) the read position needs over Spotify's own
// last-seen position before the resume action shows. Both percents are crude
// estimators (scroll depth vs playback position); small disagreements are
// noise, and Spotify's native resume already covers them.
export const RESUME_MARGIN_PERCENT = 5

export interface SpotifyResume {
  url: string
  label: string
  seconds: number
}

/** Extract the episode id from a 'spotify:episode:<id>' external id. */
export function episodeIdFromExternalId(externalId: string | null | undefined): string | null {
  if (!externalId || !externalId.startsWith(EPISODE_PREFIX)) return null
  const id = externalId.slice(EPISODE_PREFIX.length)
  return id.length > 0 ? id : null
}

/** Map a 0–100 progress percent onto the episode duration, clamped whole seconds. */
export function computeResumeSeconds(progressPercent: number, durationSeconds: number): number {
  const seconds = Math.round((progressPercent / 100) * durationSeconds)
  return Math.min(Math.max(seconds, 0), durationSeconds)
}

/** '~MM:SS', or '~H:MM:SS' from one hour up. The ~ flags the crude mapping. */
export function formatResumeTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const ss = String(s).padStart(2, '0')
  if (h > 0) return `~${h}:${String(m).padStart(2, '0')}:${ss}`
  return `~${m}:${ss}`
}

export function buildSpotifyResumeUrl(episodeId: string, seconds: number): string {
  return `https://open.spotify.com/episode/${episodeId}?t=${seconds}`
}

/**
 * The single eligibility gate for the "Resume on Spotify" action (#194
 * disagreement gate). Returns the link data, or null when the item shouldn't
 * offer it:
 * - needs a Spotify source with a spotify:episode:* external id
 * - needs a harvested read position on a text (non-audio) source — the
 *   per-source percent, NOT the item-level high-water mark, which can't say
 *   which platform produced it
 * - the read position must lead Spotify's own last-seen position by at least
 *   RESUME_MARGIN_PERCENT (unreported Spotify counts as 0) — when Spotify is
 *   at or near the read position, its native resume is strictly better
 * - needs a known duration to compute the seek target
 * - only for active items (status '' or 'In Progress')
 */
export function getSpotifyResume(item: QueueItem): SpotifyResume | null {
  if (item.status !== '' && item.status !== 'In Progress') return null

  // An item can carry multiple Spotify episode rows (#237, e.g. a private
  // feed's episode plus the public show's). Resume targets the one the user
  // has actually been listening to: highest recorded per-source position, a
  // recorded position beats an unreported one, primary breaks ties.
  const episodeSources = item.sources.filter(
    (s) => episodeIdFromExternalId(s.externalId) !== null
  )
  if (episodeSources.length === 0) return null
  const episodeSource = episodeSources.reduce((best, s) => {
    const bestPct = best.progress ?? -1
    const pct = s.progress ?? -1
    if (pct > bestPct) return s
    if (pct === bestPct && !best.isPrimary && s.isPrimary) return s
    return best
  })
  const episodeId = episodeIdFromExternalId(episodeSource.externalId)
  if (!episodeId) return null

  // Read position: the furthest per-source percent on a text source.
  const textPcts = item.sources
    .filter((s) => !AUDIO_PLATFORMS.includes(s.platform))
    .map((s) => s.progress)
    .filter((p): p is number => typeof p === 'number')
  if (textPcts.length === 0) return null
  const textPct = Math.max(...textPcts)

  const spotifyPct = episodeSource.progress ?? 0
  if (textPct < spotifyPct + RESUME_MARGIN_PERCENT) return null

  const duration = item.durationSeconds
  if (!duration || duration <= 0) return null

  const seconds = computeResumeSeconds(textPct, duration)
  return {
    url: buildSpotifyResumeUrl(episodeId, seconds),
    label: formatResumeTimestamp(seconds),
    seconds,
  }
}
