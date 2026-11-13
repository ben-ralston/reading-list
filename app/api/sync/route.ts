import { timingSafeEqual } from 'crypto'
import { NextResponse, after } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { generateSummary } from '@/lib/summary'
import { supabase } from '@/lib/supabase'
import { AWC_COMMENTS_LABEL } from '@/lib/media-type'
import { isProgressIncrease, normalizeProgress, normalizeStatus } from '@/lib/sync/normalize'
import {
  findMatchingContent,
  findByExternalId,
  shouldAutoAdd,
  updateContentProgress,
  updateSourceProgress,
  completeAwaitingComments,
  createContent,
  ensureRssSource,
  backfillExternalId,
  type SyncItem,
  type SyncSource,
} from '@/lib/sync/matching'
import { logError } from '@/lib/logger'
import { createItemErrorCollector } from '@/lib/sync/item-errors'
import { serializeError } from '@/lib/sync/serialize-error'

/**
 * Vercel function timeout. The Audible sync chunks its POSTs (50 items each) so
 * the sync itself stays well under a minute (#42), but new feed items generate
 * an Opus 5.5 summary in after() inside this same invocation (~20-45s each,
 * #304). A kill at maxDuration skips the catch and the item silently gets no
 * summary, so allow the 300s Fluid cap.
 */
export const maxDuration = 300

/**
 * Sync API Request Schema
 */
interface SyncRequest {
  source: SyncSource
  secret: string
  items: SyncItem[]
}

/**
 * Sync API Response Schema
 */
interface SyncResponse {
  success: boolean
  processed: number
  created: number
  updated: number
  skipped: number
  /** Items that threw during processing — writes that were lost, not dedup skips (RLV-024). */
  errors: number
  syncLogId: number
  /** apple_podcasts only (#322): externalIds with no matching source yet, so
   * the harvester retries them instead of recording them as delivered. */
  unmatched?: string[]
}

/**
 * Valid sync sources for validation
 */
const VALID_SOURCES: SyncSource[] = ['spotify', 'audible', 'substack', 'elevenreader', 'tasklet', 'rss', 'apple_podcasts']

/**
 * Attach a book's own content source to an already-matched content item, so an
 * Audible audiobook merges into the existing Goodreads book (Audible source
 * attached, no duplicate) rather than the dedup RPC re-resolving by exact
 * title+author and risking a duplicate on subtitle divergence (#42).
 *
 * Tolerates the UNIQUE (platform, external_id) constraint: a 23505 here means
 * the external_id is already attached to some row, which Strategy-1 matching
 * will resolve on the next sync — so it's a safe no-op, not a real failure.
 */
async function attachBookSource(
  item: SyncItem,
  contentItemId: number,
  supabase: SupabaseClient
): Promise<void> {
  if (!item.externalId) return
  try {
    await ensureRssSource(contentItemId, item.platform, item.link ?? '', item.externalId, supabase)
  } catch (e) {
    if ((e as { code?: string })?.code !== '23505') throw e
  }
}

/**
 * POST /api/sync
 *
 * Webhook endpoint for receiving progress updates from external platforms.
 * Validates auth, matches items to existing content, and updates progress.
 */
export async function POST(request: Request) {
  let syncLogId: number | null = null

  // Authenticate BEFORE the try below: its catch reports to the external
  // logger (whose rows can raise alerts), so nothing an unauthenticated
  // caller sends may reach it (#281, F13).
  let body: SyncRequest
  try {
    body = (await request.json()) as SyncRequest
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const { source, secret, items } = body

  const expectedSecret = process.env.SYNC_API_SECRET
  if (!expectedSecret) {
    console.error('[Sync API] SYNC_API_SECRET not configured')
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 })
  }

  const secretBuffer = Buffer.from(typeof secret === 'string' ? secret : '')
  const expectedBuffer = Buffer.from(expectedSecret)
  if (secretBuffer.length !== expectedBuffer.length || !timingSafeEqual(secretBuffer, expectedBuffer)) {
    return NextResponse.json({ error: 'Invalid or missing secret' }, { status: 401 })
  }

  try {

    // Validate source
    if (!source || !VALID_SOURCES.includes(source)) {
      return NextResponse.json(
        { error: `Invalid source. Must be one of: ${VALID_SOURCES.join(', ')}` },
        { status: 400 }
      )
    }

    // Validate items array
    if (!Array.isArray(items)) {
      return NextResponse.json({ error: 'Items must be an array' }, { status: 400 })
    }

    // Create sync log entry
    const { data: logData, error: insertLogError } = await supabase
      .from('sync_logs')
      .insert({
        source,
        status: 'running',
        items_processed: 0,
        items_created: 0,
        items_updated: 0,
        items_skipped: 0,
      })
      .select('id')
      .single()

    if (insertLogError) {
      console.error('[Sync API] Failed to create sync log:', insertLogError)
      // Continue without logging - non-critical
    } else {
      syncLogId = logData.id
    }

    // Process items
    let processed = 0
    let created = 0
    let updated = 0
    let skipped = 0
    // Item-level exceptions. Kept separate from `skipped` so a run where writes
    // throw can't report success — folding them into `skipped` marked the run
    // healthy while data was silently dropped (RLV-024). The collector keeps a
    // bounded sample (title + Postgres code) so an all-failed run is
    // attributable from the alert alone (#337).
    const itemErrors = createItemErrorCollector()
    const unmatched: string[] = []
    const finishedComments: Array<{ title: string; contentItemId: number }> = []

    for (const item of items) {
      // Validate required fields
      if (!item.title || !item.author) {
        console.warn('[Sync API] Skipping item with missing title/author:', item)
        skipped++
        continue
      }

      const isBook = item.kind === 'book'

      try {
        // Try to find matching content. Apple Podcasts (#322) matches by exact
        // episode GUID only — a title/link fallback could attach a listen to
        // the wrong item — and (via shouldAutoAdd) never creates one.
        const match = source === 'apple_podcasts'
          ? await findByExternalId(item.externalId, supabase)
          : await findMatchingContent(item, supabase)
        const normalizedProgress = normalizeProgress(item.progress)
        const normalizedStatus = normalizeStatus(item.status)

        if (match) {
          // A comments episode (#368) is a separate listen from the article, so
          // it never moves the item's progress. Finishing it answers the card's
          // "have you read the comments?" and does nothing at any other status.
          if (source === 'apple_podcasts' && match.sourceLabel === AWC_COMMENTS_LABEL) {
            await updateSourceProgress(match.contentItemId, item.platform, normalizedProgress, supabase, match.sourceId)
            if (normalizedStatus === 'Completed') finishedComments.push({ title: item.title, contentItemId: match.contentItemId })
            updated++
            processed++
            continue
          }

          let clampedProgress = normalizedProgress

          // Substack archived-guard (#192): the progress harvester is passive —
          // it must never resurrect an archived item (Completed/Skip flipped to
          // In Progress keeps queue_position NULL → invisible in BOTH the queue
          // and the archive) nor churn an archived item's status_changed_at
          // with daily Completed→Completed rewrites. (Active In Progress items
          // still refresh status_changed_at each run, same as the Spotify
          // sync.) This read handles the common case + the skipped count; the
          // skipArchived predicate on the update below closes the race where
          // an item is archived between this read and the write. Substack-only
          // so Spotify/Audible behavior is unchanged.
          if (source === 'substack') {
            const { data: current, error: statusError } = await supabase
              .from('content_items')
              .select('status, progress')
              .eq('id', match.contentItemId)
              .maybeSingle()
            if (statusError) throw statusError
            if (current?.status === 'Completed' || current?.status === 'Skip') {
              skipped++
              processed++
              continue
            }
            // Progress high-water mark (#192): an item can carry both a
            // Spotify and a Substack source (AI-voiced podcast of the same
            // post), and progress must only ever rise across sources — so the
            // daily read-position harvest never lowers what the hourly
            // listening sync raised. The Spotify cron applies the same gate.
            if (!isProgressIncrease(normalizedProgress, current?.progress)) {
              clampedProgress = null
            }
          }

          // Update existing content. Audible carries the guard too: the daily
          // library sync reports every book's Audible-side state, and a book
          // completed or skipped in-app must not be resurrected by it — but
          // unlike substack it keeps the rest of the item flow (source attach
          // below must still run for archived books, #42).
          await updateContentProgress(
            match.contentItemId,
            clampedProgress,
            normalizedStatus,
            supabase,
            { source, skipArchived: source === 'substack' || source === 'audible' }
          )

          // Books mode (#42): attach the audiobook's own source to the matched
          // item so it merges into the existing Goodreads book. Gated to books
          // so feed webhooks (elevenreader/substack) are unchanged.
          if (isBook) {
            await attachBookSource(item, match.contentItemId, supabase)
          }

          // Substack progress harvest (#192): RSS-created Substack sources have
          // external_id NULL, so the first match lands via title/link. Backfill
          // the harvester's substack:post:<id> so every later run is a
          // drift-proof Strategy-1 exact match.
          if (source === 'substack' && item.externalId) {
            await backfillExternalId(
              match.contentItemId,
              item.platform,
              item.link ?? '',
              item.externalId,
              supabase
            )
          }

          // Per-source progress (#194): record the platform's own last-seen
          // position on its source row — even when the high-water guard above
          // clamped the item-level merge, because "this source is behind the
          // item" is precisely the signal the Resume-on-Spotify gate needs.
          // Archived items never reach here (the guard `continue`s), and the
          // helper is best-effort (logs, never throws). Unlike the cron's
          // B2.6, there is no unchanged-value churn-guard — this per-item
          // path mirrors updateContentProgress's unconditional posture.
          await updateSourceProgress(
            match.contentItemId,
            item.platform,
            normalizedProgress,
            supabase,
            // Apple Podcasts (#322) writes the exact episode row it matched.
            source === 'apple_podcasts' ? match.sourceId : undefined
          )

          updated++
        } else if (shouldAutoAdd(source)) {
          // Completed books never sit in the active queue, so skip smart-
          // positioning to avoid full-queue churn on a first full-library sync.
          const skipPositioning = isBook && normalizedStatus === 'Completed'
          const { contentItemId: newContentId } = await createContent(item, source, supabase, { skipPositioning })

          if (isBook || source === 'spotify') {
            // Apply progress/status now so a brand-new finished audiobook shows
            // as Completed immediately, not after the next daily sync (#42).
            await updateContentProgress(newContentId, normalizedProgress, normalizedStatus, supabase, { source })
          }
          if (!isBook) {
            // Feed items get a background AI summary; books mode has none (#147).
            after(async () => {
              try {
                await generateSummary(newContentId, { skipExisting: true, auto: true })
              } catch (e) {
                console.error('[Sync API] Background summary generation failed:', e)
              }
            })
          }
          created++
        } else {
          // Skip (Spotify with no match)
          if (item.externalId) unmatched.push(item.externalId)
          skipped++
        }

        processed++
      } catch (itemError) {
        console.error('[Sync API] Error processing item:', item.title, itemError)
        itemErrors.record(item.title, itemError)
      }
    }

    // Reflect item-level failures in the run status so /settings/status and the
    // sync_logs row surface lost writes instead of staying green. 'error' when
    // no real write landed (every write threw — a legit no-op skip is not
    // progress), 'partial' when some writes succeeded alongside failures (RLV-024).
    // After the loop (#368): an article finished in this same batch must reach
    // Awaiting comments first, or the guarded write misses and the job, which
    // never resends a played episode, leaves the card waiting.
    for (const { title, contentItemId } of finishedComments) {
      try {
        await completeAwaitingComments(contentItemId, supabase)
      } catch (itemError) {
        console.error('[Sync API] Error completing item after comments episode:', itemError)
        itemErrors.record(title, itemError)
      }
    }

    const errors = itemErrors.count
    const syncStatus: 'success' | 'partial' | 'error' =
      errors === 0
        ? 'success'
        : created + updated === 0
          ? 'error'
          : 'partial'

    if (syncStatus === 'error') {
      // The alerting job fingerprints on this message's shape — keep its wording
      // stable and put the diagnostics in extra. A failed sync_logs insert is
      // the tell for a request-wide DB fault (no syncLogId), so it rides along.
      await logError('sync', `all ${errors} item write(s) failed; nothing persisted`, {
        source,
        itemCount: items.length,
        ...itemErrors.summary(),
        ...(insertLogError && { syncLogInsertError: serializeError(insertLogError) }),
        ...(syncLogId && { syncLogId }),
      })
    }

    // Update sync log with results
    if (syncLogId) {
      const { error: updateError } = await supabase
        .from('sync_logs')
        .update({
          status: syncStatus,
          completed_at: new Date().toISOString(),
          items_processed: processed,
          items_created: created,
          items_updated: updated,
          items_skipped: skipped,
          ...(errors > 0 && { metadata: itemErrors.summary() }),
        })
        .eq('id', syncLogId)

      if (updateError) {
        console.error('[Sync API] Failed to update sync log:', updateError)
        await logError('sync', updateError, { blindSpot: 'sync_logs-write', syncLogId })
      }
    }

    const response: SyncResponse = {
      success: errors === 0,
      processed,
      created,
      updated,
      skipped,
      errors,
      syncLogId: syncLogId || 0,
      ...(source === 'apple_podcasts' && { unmatched }),
    }

    return NextResponse.json(response)
  } catch (error) {
    console.error('[Sync API] Unhandled error:', error)

    await logError('sync', error, { ...(syncLogId && { syncLogId }) })

    // Update sync log with error if we have one
    if (syncLogId) {
      try {
        await supabase
          .from('sync_logs')
          .update({
            status: 'error',
            completed_at: new Date().toISOString(),
            error_message: error instanceof Error ? error.message : 'Unknown error',
          })
          .eq('id', syncLogId)
      } catch (e) {
        console.error('[Sync API] Failed to update error log:', e)
      }
    }

    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
