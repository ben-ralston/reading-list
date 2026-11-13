/**
 * Show-gap scan for the Spotify sync (#310).
 *
 * spotify-sync only sees /me/episodes, and new episodes land there as a side
 * effect of the Spotify app's auto-download — which silently skips some. Those
 * episodes never reach the queue and nothing reports it.
 *
 * On the hourly cron run the scan lists followed shows, fetches each show's
 * newest episodes, and picks the recent ones missing from saved episodes. It
 * saves them to the library so the ordinary saved-episode path (matching,
 * progress, back-catalog guard, summaries) handles them from then on.
 *
 * Recency: an episode qualifies only if released within the last
 * SHOW_GAP_LOOKBACK_DAYS days AND on/after the day its show was followed, so a
 * newly followed show never contributes its archive (see #305).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  fetchSavedShows,
  fetchShowEpisodePages,
  LIBRARY_SAVE_BATCH_SIZE,
  saveToLibrary,
  SpotifyApiError,
  type SavedEpisode,
  type SavedShow,
  type ShowEpisode,
  type SpotifyShow,
} from './client'
import { runConcurrent } from '@/lib/sync/backfill-pool'
import { chunk, SUPABASE_IN_CHUNK_SIZE } from '@/lib/sync/batch'
import { serializeError } from '@/lib/sync/serialize-error'

export const SHOW_GAP_LOOKBACK_DAYS = 7
/** Newest episodes fetched per show — one page, enough for a daily show's week. */
export const SHOW_GAP_EPISODES_PER_SHOW = 10

/** Shows fetched in parallel — polite to Spotify's rolling rate limit. */
const SHOW_FETCH_CONCURRENCY = 5
/** Episode titles kept in the sync_logs report (the counts stay exact). */
const REPORTED_EPISODES_CAP = 20

const DAY_MS = 86_400_000
const FULL_DATE = /^\d{4}-\d{2}-\d{2}$/

export interface ShowGapCandidate {
  show: SpotifyShow
  episode: ShowEpisode
}

/**
 * Recent episodes of followed shows that are not in saved episodes.
 * Dates compare as YYYY-MM-DD strings (release_date has day precision).
 */
export function selectMissingEpisodes(
  shows: SavedShow[],
  episodesByShow: Map<string, ShowEpisode[]>,
  savedIds: Set<string>,
  now: Date
): ShowGapCandidate[] {
  const windowStart = new Date(now.getTime() - SHOW_GAP_LOOKBACK_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10)

  const missing: ShowGapCandidate[] = []
  for (const { added_at, show } of shows) {
    const followedOn = added_at.slice(0, 10)
    for (const episode of episodesByShow.get(show.id) ?? []) {
      const released = episode.release_date
      if (!FULL_DATE.test(released)) continue
      if (released < windowStart || released < followedOn) continue
      if (savedIds.has(episode.id)) continue
      missing.push({ show, episode })
    }
  }
  return missing
}

/** Written to sync_logs.metadata.show_gap. */
export interface ShowGapReport {
  shows_scanned: number
  /** Recent, unsaved, not-yet-imported episodes found this run. */
  missing: number
  /** How many of those were saved to the library (and so imported this run). */
  saved: number
  by_show: Record<string, number>
  episodes: { show: string; title: string }[]
  /** Save refused/failed: nothing imported; the next run retries. */
  save_error?: string
  save_status?: number
  /** Individual shows whose episodes could not be fetched (partial; not alerted). */
  show_errors?: string[]
  /** The scan as a whole failed; the saved-episode sync is unaffected. */
  scan_error?: string
  scan_status?: number
}

export function emptyShowGapReport(): ShowGapReport {
  return { shows_scanned: 0, missing: 0, saved: 0, by_show: {}, episodes: [] }
}

export interface ShowGapResult {
  /** Newly saved episodes, shaped like /me/episodes items, to merge into the sync. */
  recovered: SavedEpisode[]
  report: ShowGapReport
}

function episodeUri(id: string): string {
  return `spotify:episode:${id}`
}

/** External ids already on a content_sources row (imported at some point). */
async function fetchKnownExternalIds(
  externalIds: string[],
  supabase: SupabaseClient
): Promise<Set<string>> {
  const known = new Set<string>()
  for (const ids of chunk(externalIds, SUPABASE_IN_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('content_sources')
      .select('external_id')
      .in('external_id', ids)
    if (error) throw error
    for (const row of data ?? []) known.add(row.external_id)
  }
  return known
}

/**
 * Find recent episodes of followed shows missing from saved episodes, save
 * them to the library, and return them for this run's sync.
 *
 * Best-effort, never throws: failures land in report.scan_error /
 * report.save_error and the caller's saved-episode sync proceeds unchanged.
 * Episodes already imported (a content_sources row exists) are never
 * re-saved — the user may have removed them from the library on purpose.
 */
export async function recoverShowGaps(
  accessToken: string,
  savedEpisodes: SavedEpisode[],
  supabase: SupabaseClient,
  now: Date = new Date()
): Promise<ShowGapResult> {
  const report = emptyShowGapReport()

  try {
    const shows = await fetchSavedShows(accessToken)
    report.shows_scanned = shows.length

    const failures: string[] = []
    const pages = await runConcurrent(
      shows,
      async ({ show }): Promise<[string, ShowEpisode[]]> => {
        try {
          const iterator = fetchShowEpisodePages(show.id, accessToken, {
            limit: SHOW_GAP_EPISODES_PER_SHOW,
          })
          const first = await iterator.next()
          await iterator.return(undefined)
          return [show.id, first.done ? [] : first.value]
        } catch (error) {
          failures.push(`${show.name}: ${serializeError(error).message}`)
          return [show.id, []]
        }
      },
      SHOW_FETCH_CONCURRENCY
    )
    if (failures.length > 0) report.show_errors = failures

    const savedIds = new Set(savedEpisodes.map((saved) => saved.episode?.id).filter(Boolean))
    const candidates = selectMissingEpisodes(shows, new Map(pages), savedIds, now)
    if (candidates.length === 0) return { recovered: [], report }

    const known = await fetchKnownExternalIds(
      candidates.map((c) => episodeUri(c.episode.id)),
      supabase
    )
    const missing = candidates.filter((c) => !known.has(episodeUri(c.episode.id)))

    report.missing = missing.length
    for (const { show, episode } of missing) {
      report.by_show[show.name] = (report.by_show[show.name] ?? 0) + 1
      if (report.episodes.length < REPORTED_EPISODES_CAP) {
        report.episodes.push({ show: show.name, title: episode.name })
      }
    }
    if (missing.length === 0) return { recovered: [], report }

    // Save batch by batch so a later failure keeps the batches Spotify
    // already accepted — those are in the library now and import this run.
    const savedCandidates: ShowGapCandidate[] = []
    for (const batch of chunk(missing, LIBRARY_SAVE_BATCH_SIZE)) {
      try {
        await saveToLibrary(
          accessToken,
          batch.map((c) => episodeUri(c.episode.id))
        )
        savedCandidates.push(...batch)
      } catch (error) {
        report.save_error = serializeError(error).message
        if (error instanceof SpotifyApiError) report.save_status = error.statusCode
        break
      }
    }

    report.saved = savedCandidates.length
    const addedAt = now.toISOString()
    return {
      recovered: savedCandidates.map(({ show, episode }) => ({
        added_at: addedAt,
        episode: { ...episode, show },
      })),
      report,
    }
  } catch (error) {
    report.scan_error = serializeError(error).message
    if (error instanceof SpotifyApiError) report.scan_status = error.statusCode
    return { recovered: [], report }
  }
}
