/**
 * Spotify episode duration backfill (#194): populate content_items.duration_seconds
 * on items whose Spotify source predates the #167 enrichment columns (INSERT-only,
 * so old rows never got a duration). The resume-link math (progress% × duration →
 * ?t= seconds) needs it; it also feeds the #167 listen-time pill.
 *
 * Mirrors the book-cover backfill (book-covers-backfill.ts): select "Spotify
 * episode items with no duration_seconds", fetch the duration via the Web API
 * single-get, and write it with a `.is('duration_seconds', null)` guard so a
 * re-run is idempotent (filled rows drop out of the selection → 0 writes).
 * Best-effort: an API/DB failure becomes a result, not a throw.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchEpisode, SpotifyApiError } from '@/lib/spotify/client'
import { runConcurrent } from './backfill-pool'

const EPISODE_PREFIX = 'spotify:episode:'

// Longest Retry-After we'll honor. Spotify's rate limit is a rolling ~30s
// window, so real values are small; anything larger means back off and rerun.
const MAX_RETRY_AFTER_SECONDS = 60

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export interface DurationRow {
  contentItemId: number
  title: string
  episodeId: string
}

export type DurationFillAction = 'filled' | 'episode-not-found' | 'failed'

export interface DurationFillResult {
  contentItemId: number
  title: string
  action: DurationFillAction
  durationSeconds: number | null
}

/**
 * Select content items that need a duration: a Spotify source with a
 * spotify:episode:* external_id whose content_item has duration_seconds IS NULL.
 * Deduped by content_item_id (an item could in theory carry two Spotify
 * sources), ordered for stable, resumable batches.
 */
export async function findItemsNeedingDuration(
  supabase: SupabaseClient,
  limit?: number
): Promise<DurationRow[]> {
  let query = supabase
    .from('content_sources')
    .select('external_id, content_item_id, content_items!inner(id, title, duration_seconds)')
    .eq('platform', 'Spotify')
    .like('external_id', `${EPISODE_PREFIX}%`)
    .is('content_items.duration_seconds', null)
    .order('content_item_id', { ascending: true })

  if (limit) query = query.limit(limit)

  const { data, error } = await query
  if (error) throw error

  const rows: DurationRow[] = []
  const seen = new Set<number>()
  for (const row of data ?? []) {
    const r = row as unknown as {
      external_id: string
      content_item_id: number
      content_items: { id: number; title: string; duration_seconds: number | null }
    }
    if (seen.has(r.content_item_id)) continue
    seen.add(r.content_item_id)
    rows.push({
      contentItemId: r.content_item_id,
      title: r.content_items.title,
      episodeId: r.external_id.slice(EPISODE_PREFIX.length),
    })
  }
  return rows
}

/**
 * Fetch one episode's duration and (unless dry-run) write it. The UPDATE is
 * guarded with `.is('duration_seconds', null)` so a concurrent writer (the
 * hourly sync's B2.5 fill) isn't clobbered. A 429 waits out Retry-After and
 * retries once (bulk runs reliably trip Spotify's rolling rate limit — without
 * this, hundreds of rows fail per pass). Never throws.
 */
export async function fillOneDuration(
  row: DurationRow,
  accessToken: string,
  supabase: SupabaseClient,
  opts: { dryRun: boolean; sleep?: (ms: number) => Promise<void> }
): Promise<DurationFillResult> {
  const sleep = opts.sleep ?? realSleep
  let episode
  try {
    try {
      episode = await fetchEpisode(accessToken, row.episodeId)
    } catch (e) {
      const retryAfter = e instanceof SpotifyApiError && e.statusCode === 429 ? e.retryAfter ?? 1 : null
      // NaN guard: an HTTP-date Retry-After parses to NaN, which would sleep(NaN) = 0ms
      if (retryAfter === null || !Number.isFinite(retryAfter) || retryAfter > MAX_RETRY_AFTER_SECONDS)
        throw e
      await sleep(retryAfter * 1000)
      episode = await fetchEpisode(accessToken, row.episodeId)
    }
  } catch {
    return { contentItemId: row.contentItemId, title: row.title, action: 'failed', durationSeconds: null }
  }

  if (!episode || !episode.duration_ms) {
    return { contentItemId: row.contentItemId, title: row.title, action: 'episode-not-found', durationSeconds: null }
  }

  const durationSeconds = Math.round(episode.duration_ms / 1000)

  if (!opts.dryRun) {
    const { error } = await supabase
      .from('content_items')
      .update({ duration_seconds: durationSeconds })
      .eq('id', row.contentItemId)
      .is('duration_seconds', null)
    if (error) {
      return { contentItemId: row.contentItemId, title: row.title, action: 'failed', durationSeconds }
    }
  }

  return { contentItemId: row.contentItemId, title: row.title, action: 'filled', durationSeconds }
}

/**
 * Run fillOneDuration over many rows with a small concurrency pool (polite to
 * the Spotify API). Returns results in input order.
 */
export async function fillDurations(
  rows: DurationRow[],
  accessToken: string,
  supabase: SupabaseClient,
  opts: { dryRun: boolean; concurrency?: number; sleep?: (ms: number) => Promise<void> }
): Promise<DurationFillResult[]> {
  return runConcurrent(
    rows,
    (row) => fillOneDuration(row, accessToken, supabase, { dryRun: opts.dryRun, sleep: opts.sleep }),
    opts.concurrency ?? 3
  )
}
