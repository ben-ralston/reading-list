/**
 * Spotify Progress Sync Cron Handler
 *
 * Vercel cron job that syncs Spotify listening progress to the queue.
 * Runs hourly, fetches saved episodes with progress, updates matching items.
 *
 * Performance: Uses batch pre-fetch and batch writes to minimize DB round-trips.
 * Typical sync (30 episodes, 25 matched, 5 new) completes in ~10-20 seconds.
 */

import { NextResponse, after } from 'next/server'
import { generateSummary } from '@/lib/summary'
import { supabase } from '@/lib/supabase'
import { getAccessToken, SpotifyAuthError } from '@/lib/spotify/auth'
import { fetchSavedEpisodes, isSpotifyServerError, SpotifyApiError, type SavedEpisode } from '@/lib/spotify/client'
import { transformToSyncItems, spotifyShowLabel } from '@/lib/spotify/transform'
import { partitionBackCatalog } from '@/lib/spotify/back-catalog'
import { emptyShowGapReport, recoverShowGaps, type ShowGapReport } from '@/lib/spotify/show-gaps'
import { fetchUnsavedQueueEpisodes } from '@/lib/spotify/unsaved-episodes'
import { normalizeProgress, normalizeStatus } from '@/lib/sync/normalize'
import { bearerTokenMatches } from '@/lib/bearer-auth'
import {
  fetchAuthorCandidates,
  createContent,
  updateContentProgress,
  updateSourceProgress,
  ensureSpotifySourceFromCache,
  type SyncItem,
  type CachedSpotifySource,
} from '@/lib/sync/matching'
import { buildDurationFill, buildSourceProgressFill } from '@/lib/spotify/sync-updates'
import { serializeError, type SerializedErrorDetails } from '@/lib/sync/serialize-error'
import { logError, logWarn } from '@/lib/logger'
import { normalizeTitle, fuzzyTitleScore } from '@/lib/sync/normalize-title'
import { chunk, SUPABASE_IN_CHUNK_SIZE } from '@/lib/sync/batch'

/** sync_logs.metadata written at insert; the success update rebuilds it. */
const SYNC_LOG_METADATA = { trigger: 'cron' } as const

/** Minimum score difference to accept a fuzzy match over the runner-up */
const AMBIGUITY_MARGIN = 0.02

interface MatchedItem {
  syncItem: SyncItem
  contentItemId: number
  sourceId?: number
}

/**
 * GET /api/cron/spotify-sync
 *
 * Accepts two forms of auth:
 * - Session cookie (browser calls from authenticated users)
 * - Bearer token via Authorization header (external callers like GitHub Actions cron)
 */
export async function GET(request: Request) {
  let syncLogId: number | null = null

  try {
    // Check for either valid session cookie or valid bearer token
    const authHeader = request.headers.get('authorization')
    const apiSecret = process.env.SYNC_API_SECRET

    let authenticated = false

    // Check bearer token first (external callers) — constant-time (RLV-016)
    const isCronTrigger = bearerTokenMatches(authHeader, apiSecret)
    if (isCronTrigger) {
      authenticated = true
    }

    // Fall back to session cookie (browser calls)
    // Dynamic import avoids eager evaluation of auth config at module load,
    // so the bearer token path still works even if AUTH_PASSWORD_SECRET is unset.
    if (!authenticated) {
      try {
        const { getSession } = await import('@/lib/auth')
        const session = await getSession()
        if (session.isAuthenticated) {
          authenticated = true
        }
      } catch {
        // Session parsing can fail for external callers with no cookies — that's fine
      }
    }

    if (!authenticated) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Create sync log entry
    const { data: logData, error: insertLogError } = await supabase
      .from('sync_logs')
      .insert({
        source: 'spotify',
        status: 'running',
        items_processed: 0,
        items_created: 0,
        items_updated: 0,
        items_skipped: 0,
        metadata: SYNC_LOG_METADATA,
      })
      .select('id')
      .single()

    if (insertLogError) {
      console.error('[Spotify Sync] Failed to create sync log:', insertLogError)
    } else {
      syncLogId = logData.id
    }

    // Step 1: Get fresh Spotify access token
    const accessToken = await getAccessToken()

    // Step 2: Fetch saved episodes with resume points
    const savedEpisodes = await fetchSavedEpisodes(accessToken)

    // Step 2.5: Show-gap scan (#310), hourly cron only — the browser's
    // frequent auto-syncs don't need it. Recent episodes of followed shows
    // that auto-download never saved get saved to the library and join this
    // run as ordinary saved episodes. Best-effort: never fails the sync.
    let showGap: ShowGapReport | null = null
    let episodes = savedEpisodes
    if (isCronTrigger) {
      try {
        const result = await recoverShowGaps(accessToken, savedEpisodes, supabase)
        showGap = result.report
        episodes = [...savedEpisodes, ...result.recovered]
      } catch (scanError) {
        // recoverShowGaps is contracted never to throw; belt and braces.
        showGap = { ...emptyShowGapReport(), scan_error: serializeError(scanError).message }
      }
      // Alert on a failed scan and on an unexpected save failure. Per-show
      // fetch failures (show_errors) stay in sync_logs only — one flaky show
      // must not raise an alert every hour — and so does a 403 on the save,
      // expected until the user-library-modify re-auth
      // (docs/spotify-reauth-runbook.md).
      // A Spotify 5xx (already retried by the client) goes to warn, not
      // error, so an upstream outage does not file an alert (#342).
      const alerts = [
        { message: showGap.scan_error, status: showGap.scan_status },
        ...(showGap.save_status !== 403
          ? [{ message: showGap.save_error, status: showGap.save_status }]
          : []),
      ]
      for (const { message, status } of alerts) {
        if (!message) continue
        const report = status !== undefined && status >= 500 ? logWarn : logError
        await report('spotify-sync', message, {
          blindSpot: 'show-gap-scan',
          ...(syncLogId && { syncLogId }),
          ...(status !== undefined && { spotifyStatus: status }),
        })
      }
      if (showGap.missing > 0) {
        console.log(`[Spotify Sync] Show-gap scan: ${showGap.missing} missing, ${showGap.saved} saved`, showGap.by_show)
      }
    }

    // Step 2.6: Unsaved queue episodes (#329), hourly cron only like the
    // show-gap scan. Spotify removes an episode from Your Episodes once it is
    // fully played, so a finish no sync caught in time was never reported.
    // Fetch the missing episodes of items still in the queue directly. They
    // only update existing items — never created, never counted by the
    // back-catalog guard. Best-effort: never fails the sync.
    let unsavedEpisodes: SavedEpisode[] = []
    if (isCronTrigger) {
      try {
        unsavedEpisodes = await fetchUnsavedQueueEpisodes(accessToken, episodes, supabase)
      } catch (unsavedError) {
        const message = serializeError(unsavedError).message
        console.error('[Spotify Sync] Unsaved queue episode lookup failed:', message)
        const report = isSpotifyServerError(unsavedError) ? logWarn : logError
        await report('spotify-sync', message, {
          blindSpot: 'unsaved-queue-episodes',
          ...(syncLogId && { syncLogId }),
          ...(unsavedError instanceof SpotifyApiError && { spotifyStatus: unsavedError.statusCode }),
        })
      }
    }

    // Step 3: Transform to sync format
    const syncItems = transformToSyncItems(episodes)
    const unsavedSyncItems = transformToSyncItems(unsavedEpisodes)
    console.log(
      `[Spotify Sync] Found ${episodes.length} saved episodes, ${syncItems.length} with progress, ${unsavedSyncItems.length} unsaved queue episodes`
    )

    // ============================================================
    // Phase A: Batch pre-fetch
    // ============================================================

    // A1: Batch external ID lookup — single query for all sync items
    const externalIds = [...syncItems, ...unsavedSyncItems]
      .filter((item) => item.externalId)
      .map((item) => item.externalId!)

    const externalIdMap = new Map<string, { sourceId: number; contentItemId: number }>()

    if (externalIds.length > 0) {
      // Chunk to keep request URL under undici's ~16KB header limit (see #143).
      const chunkedResults = await Promise.all(
        chunk(externalIds, SUPABASE_IN_CHUNK_SIZE).map((ids) =>
          supabase
            .from('content_sources')
            .select('id, content_item_id, external_id')
            .in('external_id', ids)
        )
      )

      for (const { data: sourceMatches, error: sourceError } of chunkedResults) {
        if (sourceError) {
          console.error('[Spotify Sync] Error batch-fetching external IDs:', sourceError)
          throw sourceError
        }
        for (const match of sourceMatches || []) {
          externalIdMap.set(match.external_id, {
            sourceId: match.id,
            contentItemId: match.content_item_id,
          })
        }
      }
    }

    // Categorize: matched by external ID vs needs title matching
    const matchedItems: MatchedItem[] = []
    const unmatchedItems: SyncItem[] = []

    for (const item of syncItems) {
      if (item.externalId && externalIdMap.has(item.externalId)) {
        const match = externalIdMap.get(item.externalId)!
        matchedItems.push({
          syncItem: item,
          contentItemId: match.contentItemId,
          sourceId: match.sourceId,
        })
      } else {
        unmatchedItems.push(item)
      }
    }

    // Unsaved queue episodes (#329) update existing items only: an episode
    // whose source vanished since the lookup is dropped, not title-matched.
    for (const item of unsavedSyncItems) {
      const match = item.externalId ? externalIdMap.get(item.externalId) : undefined
      if (match) {
        matchedItems.push({
          syncItem: item,
          contentItemId: match.contentItemId,
          sourceId: match.sourceId,
        })
      }
    }

    // A2+A3: Parallel author candidates fetch for unmatched items
    const uniqueAuthors = [...new Set(unmatchedItems.map((item) => item.author))]
    const candidatesEntries = await Promise.all(
      uniqueAuthors.map(async (author) => {
        const candidates = await fetchAuthorCandidates(author, 'feed', supabase)
        return [author, candidates] as const
      })
    )
    const candidatesMap = new Map(candidatesEntries)

    // In-memory title matching for unmatched items
    const unmatchedNewItems: SyncItem[] = []

    for (const item of unmatchedItems) {
      const candidates = candidatesMap.get(item.author) || []
      const incomingNormalized = normalizeTitle(item.title, item.author)

      if (incomingNormalized === '') {
        unmatchedNewItems.push(item)
        continue
      }

      const normalized = candidates
        .map((c) => ({
          id: c.id,
          normalizedTitle: normalizeTitle(c.title, c.author),
        }))
        .filter(({ normalizedTitle }) => normalizedTitle !== '')

      // Exact normalized match first
      let found = false
      for (const { id, normalizedTitle } of normalized) {
        if (normalizedTitle === incomingNormalized) {
          matchedItems.push({ syncItem: item, contentItemId: id })
          found = true
          break
        }
      }
      if (found) continue

      // Fuzzy match with ambiguity check
      const scored = normalized
        .map(({ id, normalizedTitle }) => ({
          id,
          score: fuzzyTitleScore(incomingNormalized, normalizedTitle),
        }))
        .filter((entry): entry is { id: number; score: number } => entry.score !== null)
        .sort((a, b) => b.score - a.score || a.id - b.id)

      if (scored.length > 0) {
        if (scored.length > 1 && scored[0].score - scored[1].score < AMBIGUITY_MARGIN) {
          unmatchedNewItems.push(item) // Ambiguous match, treat as new
        } else {
          matchedItems.push({ syncItem: item, contentItemId: scored[0].id })
        }
      } else {
        unmatchedNewItems.push(item)
      }
    }

    // Back-catalog guard (#305): a show's archive dumped into saved episodes
    // (e.g. after following it) is not queued. Already-imported episodes above
    // still sync progress; only creation is suppressed.
    const {
      keep: newItems,
      skipped: backCatalogItems,
      skippedByShow: backCatalogByShow,
    } = partitionBackCatalog(unmatchedNewItems, syncItems)
    if (backCatalogItems.length > 0) {
      console.log(
        `[Spotify Sync] Skipped ${backCatalogItems.length} back-catalog episode(s):`,
        backCatalogByShow
      )
    }

    console.log(`[Spotify Sync] Matched: ${matchedItems.length}, New: ${newItems.length}`)

    // A4+A5: Batch fetch durations and Spotify sources for all matched items
    const matchedIds = [...new Set(matchedItems.map((m) => m.contentItemId))]

    // Chunk both lookups to keep request URLs under undici's header limit (see #143).
    type StatusRow = {
      id: number
      duration_seconds: number | null
    }
    type SpotifySourceRow = {
      id: number
      content_item_id: number
      link: string
      external_id: string | null
      progress: number | null
      source_label: string | null
    }
    type ChunkedResult<T> = { data: T[]; error: { message: string } | null }

    async function fetchChunkedById<T>(
      runChunk: (ids: number[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
    ): Promise<ChunkedResult<T>> {
      if (matchedIds.length === 0) return { data: [], error: null }
      const results = await Promise.all(chunk(matchedIds, SUPABASE_IN_CHUNK_SIZE).map(runChunk))
      const merged: T[] = []
      for (const { data, error } of results) {
        if (error) return { data: [], error }
        if (data) merged.push(...data)
      }
      return { data: merged, error: null }
    }

    const [statusResult, spotifySourceResult] = await Promise.all([
      fetchChunkedById<StatusRow>((ids) =>
        supabase.from('content_items').select('id, duration_seconds').in('id', ids)
      ),
      fetchChunkedById<SpotifySourceRow>((ids) =>
        supabase
          .from('content_sources')
          .select('id, content_item_id, link, external_id, progress, source_label')
          .in('content_item_id', ids)
          .eq('platform', 'Spotify')
      ),
    ])

    if (statusResult.error) {
      console.error('[Spotify Sync] Error batch-fetching statuses:', statusResult.error)
      throw statusResult.error
    }
    if (spotifySourceResult.error) {
      console.error('[Spotify Sync] Error batch-fetching Spotify sources:', spotifySourceResult.error)
      throw spotifySourceResult.error
    }

    const durationMap = new Map<number, number | null>()
    for (const row of statusResult.data || []) {
      durationMap.set(row.id, row.duration_seconds)
    }

    // ALL Spotify rows per item — ensureSpotifySourceFromCache is
    // external_id-aware, so distinct episodes keep distinct rows (#237).
    const spotifySourceMap = new Map<number, CachedSpotifySource[]>()
    for (const row of spotifySourceResult.data || []) {
      const cached = {
        id: row.id,
        link: row.link,
        external_id: row.external_id,
        progress: row.progress,
        source_label: row.source_label,
      }
      const list = spotifySourceMap.get(row.content_item_id)
      if (list) list.push(cached)
      else spotifySourceMap.set(row.content_item_id, [cached])
    }

    // ============================================================
    // Phase B: Batch writes for matched items
    // ============================================================

    // B1+B2: Send incoming Spotify state, not decisions from a stale snapshot.
    // The RPC locks rows, checks LessWrong sources, and merges progress/status.
    const batchUpdates = matchedItems.map(({ contentItemId, syncItem }) => ({
      id: contentItemId,
      progress: normalizeProgress(syncItem.progress),
      status: normalizeStatus(syncItem.status),
      // Lets the RPC ignore Spotify on items being heard through Askwho Casts (#364).
      source: 'spotify',
    }))
    if (batchUpdates.length > 0) {
      const { error: batchError } = await supabase.rpc('apply_spotify_progress', {
        updates: batchUpdates,
      })
      if (batchError) {
        console.error('[Spotify Sync] Batch update error:', batchError)
        throw batchError
      }
    }

    // B2.5: Fill missing duration_seconds (#194). duration_seconds is #167
    // INSERT-only enrichment, so pre-#167 items have NULL; the resume-link
    // math needs it. Guarded direct updates (NULL-only, never overwrite),
    // outside the batch RPC which has no duration field. Failures are logged
    // but never fail the sync.
    const durationFills = matchedItems
      .map((m) =>
        buildDurationFill(
          m.contentItemId,
          m.syncItem.durationSeconds,
          durationMap.get(m.contentItemId) ?? null
        )
      )
      .filter((fill): fill is NonNullable<typeof fill> => fill !== null)

    if (durationFills.length > 0) {
      const fillResults = await Promise.allSettled(
        durationFills.map(async (fill) => {
          const { error } = await supabase
            .from('content_items')
            .update({ duration_seconds: fill.duration_seconds })
            .eq('id', fill.id)
            .is('duration_seconds', null)
          if (error) throw error
        })
      )
      const fillFailures = fillResults.filter((r) => r.status === 'rejected')
      if (fillFailures.length > 0) {
        const reasons = fillFailures.map((r) => (r as PromiseRejectedResult).reason)
        console.error(`[Spotify Sync] ${fillFailures.length} duration fill(s) failed:`, reasons)
      }
      console.log(
        `[Spotify Sync] Filled duration_seconds on ${durationFills.length - fillFailures.length} item(s)`
      )
    }

    // B2.6: Per-source progress (#194). Record Spotify's own last-seen percent
    // on the Spotify source row — deliberately last-seen, not high-water: the
    // resume gate compares the read position against where Spotify actually
    // is, so re-listen regressions must land. buildSourceProgressFill skips
    // unchanged values (hourly churn guard). Best-effort like B2.5.
    //
    // An item can carry multiple Spotify episode rows (#237), so the percent
    // must land on THIS episode's row — selected the same way
    // ensureSpotifySourceFromCache adopts one: by external_id, else a legacy
    // unlabeled row with the same link. Other episodes' rows keep their own
    // positions.
    const sourceProgressFills = matchedItems
      .map((m) => {
        const rows = spotifySourceMap.get(m.contentItemId) ?? []
        const episodeRow =
          rows.find((s) => s.external_id === m.syncItem.externalId) ??
          rows.find((s) => s.external_id === null && s.link === m.syncItem.link) ??
          null
        return buildSourceProgressFill(episodeRow, normalizeProgress(m.syncItem.progress))
      })
      .filter((fill): fill is NonNullable<typeof fill> => fill !== null)

    if (sourceProgressFills.length > 0) {
      const progressResults = await Promise.allSettled(
        sourceProgressFills.map(async (fill) => {
          const { error } = await supabase
            .from('content_sources')
            .update({ progress: fill.progress })
            .eq('id', fill.sourceId)
          if (error) throw error
        })
      )
      const progressFailures = progressResults.filter((r) => r.status === 'rejected')
      if (progressFailures.length > 0) {
        console.error(
          `[Spotify Sync] ${progressFailures.length} source progress write(s) failed:`,
          progressFailures.map((r) => (r as PromiseRejectedResult).reason)
        )
      }
      console.log(
        `[Spotify Sync] Wrote per-source progress on ${sourceProgressFills.length - progressFailures.length} source(s)`
      )
    }

    // B3: Parallel source upserts for matched items. Note: a Spotify source
    // INSERTED here (item newly matched to an episode) gets NULL progress and
    // isn't in spotifySourceMap, so B2.6 above skipped it — its per-source
    // progress lands on the NEXT cron run (accepted one-run delay, #194).
    const sourceUpsertResults = await Promise.allSettled(
      matchedItems
        .filter((m) => m.syncItem.link && m.syncItem.externalId)
        .map((m) =>
          ensureSpotifySourceFromCache(
            m.contentItemId,
            m.syncItem.link!,
            m.syncItem.externalId!,
            spotifySourceMap.get(m.contentItemId) ?? [],
            supabase,
            // syncItem.author is the show name (normalizeShowName in the Spotify
            // transform); persist it as the source label so two Spotify episodes
            // on one item are distinguishable (#245). The 'Unknown Show' sentinel
            // is not a real label — store null so the UI degrades cleanly.
            spotifyShowLabel(m.syncItem.author)
          )
        )
    )

    const sourceFailures = sourceUpsertResults.filter((r) => r.status === 'rejected')
    if (sourceFailures.length > 0) {
      const reasons = sourceFailures.map((r) => (r as PromiseRejectedResult).reason)
      console.error(`[Spotify Sync] ${sourceFailures.length} source upsert(s) failed:`, reasons)
    }

    const updated = matchedItems.length - sourceFailures.length

    // ============================================================
    // Phase C: Sequential new item creation
    // ============================================================

    let created = 0
    let skipped = 0

    for (const item of newItems) {
      try {
        const { contentItemId: newContentId } = await createContent(item, 'spotify', supabase)
        after(async () => {
          try {
            await generateSummary(newContentId, { skipExisting: true, auto: true })
          } catch (e) {
            console.error('[Spotify Sync] Background summary generation failed:', e)
          }
        })
        const normalizedProgress = normalizeProgress(item.progress)
        const normalizedStatus = normalizeStatus(item.status)
        await updateContentProgress(newContentId, normalizedProgress, normalizedStatus, supabase, { source: 'spotify' })
        // Per-source progress (#194): stamp the initial Spotify position on
        // the just-created source (createContent made it; match by platform).
        await updateSourceProgress(newContentId, 'Spotify', normalizedProgress, supabase)
        created++
      } catch (itemError) {
        console.error(`[Spotify Sync] Error creating "${item.title}":`, itemError)
        skipped++
      }
    }

    skipped += sourceFailures.length
    const processed = matchedItems.length + created + skipped

    // Update sync log with results. The update replaces the insert-time
    // jsonb, so carry it along — and only write metadata when there is news.
    const recordShowGap =
      showGap !== null &&
      (showGap.missing > 0 || !!showGap.scan_error || !!showGap.show_errors?.length)
    const successMetadata =
      backCatalogItems.length > 0 || recordShowGap
        ? {
            ...SYNC_LOG_METADATA,
            ...(backCatalogItems.length > 0 && {
              back_catalog_skipped: {
                total: backCatalogItems.length,
                by_show: backCatalogByShow,
              },
            }),
            ...(recordShowGap && { show_gap: showGap }),
          }
        : null

    if (syncLogId) {
      const { error: updateLogError } = await supabase
        .from('sync_logs')
        .update({
          status: 'success',
          completed_at: new Date().toISOString(),
          items_processed: processed,
          items_created: created,
          items_updated: updated,
          items_skipped: skipped,
          ...(successMetadata && { metadata: successMetadata }),
        })
        .eq('id', syncLogId)
      if (updateLogError) {
        console.error('[Spotify Sync] Failed to update sync log (success):', updateLogError)
        await logError('spotify-sync', updateLogError, {
          blindSpot: 'sync_logs-write',
          syncLogId,
        })
      }
    }

    console.log(`[Spotify Sync] Complete: ${created} created, ${updated} updated, ${skipped} skipped`)

    return NextResponse.json({
      success: true,
      processed,
      created,
      updated,
      skipped,
      backCatalogSkipped: backCatalogItems.length,
      ...(showGap && { showGap: { missing: showGap.missing, saved: showGap.saved } }),
      syncLogId,
    })
  } catch (error) {
    console.error('[Spotify Sync] Error:', error)

    // Determine error type for response. Auth/API branches keep their custom
    // status codes; everything else (including Supabase PostgrestError objects
    // that are NOT `instanceof Error`) goes through serializeError so the DB
    // captures message + hint + details instead of "Unknown error".
    let errorMessage: string
    let statusCode = 500
    let errorDetails: SerializedErrorDetails | null = null

    if (error instanceof SpotifyAuthError && error.errorCode === 'refresh_token_unavailable') {
      // The refresh token could not be *read* (transient app_settings blip),
      // which says nothing about the token itself — label it honestly so the
      // alerting job does not file it as a Spotify auth problem
      // (ops issue #334).
      errorMessage = `Database error: ${error.message}`
    } else if (error instanceof SpotifyAuthError) {
      errorMessage = `Auth error: ${error.message}`
      statusCode = error.statusCode === 401 ? 401 : 500
    } else if (error instanceof SpotifyApiError) {
      errorMessage = `API error: ${error.message}`
      statusCode = error.statusCode === 429 ? 429 : 500
    } else {
      const serialized = serializeError(error)
      errorMessage = serialized.message
      errorDetails = serialized.details
    }

    // A Spotify 5xx has already been retried by the client, so what reaches
    // here is an upstream outage that clears on its own: warn, so the log
    // alerting job does not file an issue for each one (#342). The run is still
    // recorded as errored in sync_logs below. Everything else stays at error.
    const report = isSpotifyServerError(error) ? logWarn : logError
    await report('spotify-sync', errorMessage, {
      ...(errorDetails && { error: errorDetails }),
      ...(syncLogId && { syncLogId }),
      statusCode,
      ...(error instanceof SpotifyApiError && { spotifyStatus: error.statusCode }),
    })

    // Update sync log with error. Preserve the insert-time `trigger: 'cron'`
    // metadata when we have new error details to merge in (the update would
    // otherwise replace the whole jsonb column).
    if (syncLogId) {
      const { error: updateLogError } = await supabase
        .from('sync_logs')
        .update({
          status: 'error',
          completed_at: new Date().toISOString(),
          error_message: errorMessage,
          ...(errorDetails && {
            metadata: { ...SYNC_LOG_METADATA, error: errorDetails },
          }),
        })
        .eq('id', syncLogId)
      if (updateLogError) {
        console.error('[Spotify Sync] Failed to update sync log (error):', updateLogError)
        await logError('spotify-sync', updateLogError, {
          blindSpot: 'sync_logs-write',
          syncLogId,
        })
      }
    }

    return NextResponse.json({ error: errorMessage }, { status: statusCode })
  }
}
