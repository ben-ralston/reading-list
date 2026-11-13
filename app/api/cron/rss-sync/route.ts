/**
 * RSS Feed Sync Cron Handler
 *
 * Vercel cron job that fetches all configured RSS feeds in parallel,
 * parses new items, and adds them to the queue via the existing sync logic.
 *
 * Schedule: Every 15 minutes
 */

import { NextResponse, after } from 'next/server'
import RssParser from 'rss-parser'
import { fetchFeed } from '@/lib/rss/fetch-feed'
import { generateSummary } from '@/lib/summary'
import { supabase } from '@/lib/supabase'
import { listFeeds, recordFeedSuccess, recordFeedError, type RssFeed } from '@/lib/rss/feeds-repo'
import { parseRssItems, type RssItem } from '@/lib/rss/parser'
import { enrichFromUrl } from '@/lib/rss/enrich'
import { bearerTokenMatches } from '@/lib/bearer-auth'
import {
  findMatchingContent,
  createContent,
  ensureRssSource,
  type SyncSource,
} from '@/lib/sync/matching'
import { serializeError } from '@/lib/sync/serialize-error'
import { logError } from '@/lib/logger'

const RSS_SOURCE: SyncSource = 'rss'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Sanity bound on items a steady-state feed may yield past its cutoff in one
 * run (#287). Normal runs process 1–8 items across ALL feeds; the largest feed
 * (LessWrong Buzzsprout) carries ~1000. Anything above this on a non-first-poll
 * run means the cutoff is wrong, not that the feed published 100+ posts in
 * 15 minutes — skip the feed and surface it as a feed error rather than ingest.
 * First-poll feeds are exempt: their window is the deliberate backfill (#164).
 */
const MAX_NEW_ITEMS_PER_FEED = 100

/**
 * GET /api/cron/rss-sync
 *
 * Accepts two forms of auth:
 * - Bearer token via Authorization header (Vercel cron / external callers)
 * - Session cookie (browser calls from authenticated users)
 */
export async function GET(request: Request) {
  let syncLogId: number | null = null

  try {
    // Check for either valid session cookie or valid bearer token
    const authHeader = request.headers.get('authorization')
    const apiSecret = process.env.SYNC_API_SECRET

    let authenticated = false

    // Check bearer token first (external callers) — constant-time (RLV-016)
    if (bearerTokenMatches(authHeader, apiSecret)) {
      authenticated = true
    }

    // Fall back to session cookie (browser calls)
    if (!authenticated) {
      try {
        const { getSession } = await import('@/lib/auth')
        const session = await getSession()
        if (session.isAuthenticated) {
          authenticated = true
        }
      } catch {
        // Session parsing can fail for external callers with no cookies
      }
    }

    if (!authenticated) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Create sync log entry
    const { data: logData, error: insertLogError } = await supabase
      .from('sync_logs')
      .insert({
        source: RSS_SOURCE,
        status: 'running',
        items_processed: 0,
        items_created: 0,
        items_updated: 0,
        items_skipped: 0,
      })
      .select('id')
      .single()

    if (insertLogError) {
      console.error('[RSS Sync] Failed to create sync log:', insertLogError)
    } else {
      syncLogId = logData.id
    }

    // Load the active feed list from the DB (previously a static config constant).
    const feeds: RssFeed[] = await listFeeds({ includeDisabled: false })
    if (feeds.length === 0) console.warn('[RSS Sync] No active feeds configured')

    // Fetch all feeds in parallel. customFields surface media:thumbnail/
    // media:content for the feed-card thumbnail (#167); content:encoded,
    // enclosure, and itunes.* are already default rss-parser fields.
    const parser = new RssParser({
      customFields: {
        item: [
          ['media:thumbnail', 'media:thumbnail'],
          ['media:content', 'media:content'],
        ],
      },
    })
    const feedResults = await Promise.allSettled(
      feeds.map(async (feed) => {
        // SSRF-guarded (#206): stored feed URLs are re-fetched hourly and
        // their DNS can change after insert-time validation.
        const parsed = await fetchFeed(feed.url, parser)
        // customFields makes rss-parser infer item props that lack RssItem's
        // index signature, so narrow via unknown (RssItem is our own structural type).
        return { feed, items: parsed.items as unknown as RssItem[] }
      })
    )

    let created = 0
    let skipped = 0
    let skippedMissingLink = 0
    let sourcesAttached = 0
    // Item-level failures (createContent throwing, etc.). Kept separate from
    // `skipped` so a failed item can't be logged as a healthy dedup skip: it
    // holds the run below 'success' (visible on /settings/status) and keeps
    // its feed off recordFeedSuccess (so the feed's cutoff doesn't advance past
    // the failed item and a first-poll backfill window isn't consumed) —
    // otherwise the item is filtered out forever (RLV-014).
    let itemErrors = 0
    // Per-feed failures captured here are persisted to sync_logs so that
    // partial outages (one Substack down, others healthy) are visible from
    // the DB without scraping cron worker logs. See #132.
    // `kind` labels each entry as a fetch failure or a sanity-guard skip
    // (#287) so the metadata explains itself on /settings/status.
    const feedErrors: { url: string; reason: string; kind: 'fetch' | 'guard' }[] = []

    for (let i = 0; i < feedResults.length; i++) {
      const result = feedResults[i]
      if (result.status === 'rejected') {
        const failed = feeds[i]
        const url = failed.url
        const reason = result.reason instanceof Error
          ? `${result.reason.name}: ${result.reason.message}`
          : String(result.reason)
        feedErrors.push({ url, reason, kind: 'fetch' })
        await recordFeedError(failed.id, reason)
        console.error('[RSS Sync] Feed fetch failed:', url, result.reason)
        continue
      }

      const { feed, items } = result.value
      const parsedItems = parseRssItems(items, feed)

      // Track item-level failures for THIS feed so we can withhold
      // recordFeedSuccess — a feed that failed to persist an item must stay
      // first-poll-eligible to retry it (RLV-014).
      let feedItemErrors = 0

      // Filter to items newer than the per-feed cutoff:
      // - Never-polled feed (last_success_at NULL): opt-in backfill window of
      //   `backfill_days` days, or 0 days ("from now forward") when off. Always
      //   bounded, so "off" can't ingest the whole back catalog (#164).
      // - Otherwise: the feed's own last_success_at — the last time THIS feed
      //   was fully processed. The cutoff is never null and never depends on
      //   a sync_logs read: the previous global "last successful run" lookup
      //   returned null on a transient gateway error, which read as "never
      //   synced" and ingested every feed's whole back catalog (#287). A
      //   per-feed boundary also can't be frozen by another feed's failure.
      // Both subtract an extra day because publishedOn is date-only (midnight
      // UTC) while the cutoff carries wall-clock time — without the buffer,
      // items from the boundary day get dropped.
      const isFirstPoll = feed.lastSuccessAt === null
      const cutoff =
        feed.lastSuccessAt === null
          ? new Date(Date.now() - ((feed.backfillDays ?? 0) + 1) * DAY_MS)
          : new Date(new Date(feed.lastSuccessAt).getTime() - DAY_MS)
      // Undated items are normally included (a genuinely-new dateless item must
      // not be dropped). The one exception: a never-polled feed with backfill
      // OFF — there, an undated item is indistinguishable from old back catalog,
      // so honoring "off" means excluding it. It's picked up next cycle once the
      // feed is in steady state. (#164 review)
      const excludeUndated = isFirstPoll && feed.backfillDays == null
      const newItems = parsedItems.filter((item) => {
        if (!item.publishedOn) return !excludeUndated
        return new Date(item.publishedOn) > cutoff
      })

      // Defense in depth behind the cutoff (#287): an implausible influx on a
      // steady-state feed is skipped and reported, never ingested. The skip
      // advances the feed's cutoff — otherwise the same items re-trip the
      // guard every 15 minutes with no recovery path. If the items were
      // legitimate (a feed re-activated after months), the alert below says
      // so and scripts/rss-backfill-* recovers them.
      if (!isFirstPoll && newItems.length > MAX_NEW_ITEMS_PER_FEED) {
        const reason =
          `${newItems.length} items past cutoff exceeds sanity bound of ` +
          `${MAX_NEW_ITEMS_PER_FEED}; feed skipped, cutoff advanced (#287)`
        console.error('[RSS Sync] Feed skipped:', feed.url, reason)
        feedErrors.push({ url: feed.url, reason, kind: 'guard' })
        await recordFeedError(feed.id, reason, { advanceCutoff: true })
        continue
      }

      for (const item of newItems) {
        // LessWrong feeds occasionally yield items with no item-level <link>
        // and no lesswrong.com/posts/ URL in the description — creating one
        // would fail at the RPC ("Link is required") and get swallowed by
        // the outer catch. Filter here with a named counter so it's visible.
        if (feed.feedType === 'lesswrong' && (!item.link || item.link.trim() === '')) {
          skippedMissingLink++
          console.log('[RSS Sync] LW item with no extractable link, skipping:', item.title)
          continue
        }

        try {
          const match = await findMatchingContent(item, supabase)

          if (match) {
            // Matched existing content — ensure the feed's own platform source
            // is attached so items originally created by another platform
            // (e.g., a LessWrong episode created by Spotify) gain their
            // feed-side link.
            if (item.link && item.link.trim() !== '') {
              const sourceResult = await ensureRssSource(
                match.contentItemId,
                feed.platform,
                item.link,
                undefined,
                supabase
              )
              if (sourceResult === 'inserted' || sourceResult === 'updated') {
                sourcesAttached++
              }
            }
            skipped++
          } else {
            // og:image fallback (#167): only items we actually create pay the
            // network cost. enrichFromUrl never throws — failures leave the
            // cheap signals (often null) untouched, so the card just shows the
            // source-tinted placeholder.
            if (!item.imageUrl && item.link) {
              const fallback = await enrichFromUrl(item.link)
              if (fallback.imageUrl) item.imageUrl = fallback.imageUrl
              if (item.wordCount == null && fallback.wordCount != null) {
                item.wordCount = fallback.wordCount
              }
            }
            const { contentItemId: newContentId } = await createContent(item, RSS_SOURCE, supabase)
            after(async () => {
              try {
                await generateSummary(newContentId, { skipExisting: true, auto: true })
              } catch (e) {
                console.error('[RSS Sync] Background summary generation failed:', e)
              }
            })
            created++
          }
        } catch (itemError) {
          console.error('[RSS Sync] Error processing item:', item.title, itemError)
          itemErrors++
          feedItemErrors++
        }
      }

      // Only mark the feed healthy when every item persisted. On item failures
      // record an error instead — this leaves last_success_at untouched, so a
      // never-polled feed stays first-poll-eligible and retries the failed item
      // next run rather than filtering it out forever (RLV-014).
      if (feedItemErrors === 0) {
        await recordFeedSuccess(feed.id, items.length)
      } else {
        await recordFeedError(feed.id, `${feedItemErrors} item(s) failed to persist`)
      }
    }

    const processed = created + skipped + skippedMissingLink + itemErrors

    // Update sync log. items_updated tracks `sourcesAttached` — i.e. matched
    // rows that gained a feed-side content_sources entry on this run. This is
    // the only durable signal that Bug #1's attach pass is working.
    //
    // status reflects run health: 'success' (all feeds OK and every item
    // persisted), 'partial' (some feeds failed — fetch or guard — OR some
    // items failed to persist), 'error' (every feed failed, nothing ingested).
    // The ingest cutoff is per-feed (last_success_at), so a partial run never
    // freezes healthy feeds, and a fetch-failed feed / failed item is still
    // picked up next run.
    const guardSkips = feedErrors.filter((e) => e.kind === 'guard').length
    const allFeedsFailed = feeds.length > 0 && feedErrors.length >= feeds.length
    const syncStatus: 'success' | 'partial' | 'error' =
      allFeedsFailed
        ? 'error'
        : feedErrors.length > 0 || itemErrors > 0
          ? 'partial'
          : 'success'

    // Combined diagnostics: per-feed fetch failures (#132) plus the item-level
    // failure count (RLV-014). Stays null on a fully healthy run so /settings
    // /status metadata stays sparse.
    const metadata =
      feedErrors.length > 0 || itemErrors > 0
        ? {
            ...(feedErrors.length > 0 && { feedErrors }),
            ...(itemErrors > 0 && { itemErrors }),
          }
        : null

    // One alert per run. A guard trip is always an anomaly (implausible
    // cutoff, or a feed that re-dated its catalog) and a 'partial' run pages
    // nobody on its own, so it is reported explicitly (#287).
    if (syncStatus === 'error') {
      await logError('rss-sync', `all ${feeds.length} feeds failed (fetch or sanity guard)`, {
        feedErrors,
        ...(syncLogId && { syncLogId }),
      })
    } else if (guardSkips > 0) {
      await logError('rss-sync', `${guardSkips} feed(s) skipped: items past cutoff exceeded sanity bound`, {
        feedErrors,
        ...(syncLogId && { syncLogId }),
      })
    }

    // The DB row is the source of truth for sync health (#132). If this
    // update fails (schema cache stale after a migration deploy, transient
    // DB error, etc.), the row stays in 'running' with no feed_errors —
    // exactly the blind spot #132 was opened to close. Surface the failure
    // in the response so the cron worker can log/alert on it. We keep
    // HTTP 200 because the work itself completed; flipping to 500 would
    // risk a worker-level retry of already-done work.
    let syncLogError: string | null = null

    if (syncLogId) {
      const { error: updateError } = await supabase
        .from('sync_logs')
        .update({
          status: syncStatus,
          completed_at: new Date().toISOString(),
          items_processed: processed,
          items_created: created,
          items_updated: sourcesAttached,
          items_skipped: skipped + skippedMissingLink,
          feed_errors: feedErrors.length,
          metadata,
        })
        .eq('id', syncLogId)

      if (updateError) {
        syncLogError = updateError.message ?? 'sync_logs update failed'
        console.error('[RSS Sync] Failed to update sync log:', updateError)
        await logError('rss-sync', updateError, {
          blindSpot: 'sync_logs-write',
          syncLogId,
        })
      }
    } else {
      // Insert failed earlier; the work ran but no row exists to mark.
      syncLogError = 'sync_logs insert failed; no row to update'
      await logError('rss-sync', insertLogError ?? 'sync_logs insert failed; no row to update', {
        blindSpot: 'sync_logs-write',
      })
    }

    return NextResponse.json({
      success: syncLogError === null,
      status: syncStatus,
      processed,
      created,
      skipped,
      skippedMissingLink,
      errors: itemErrors,
      sourcesAttached,
      feedErrors: feedErrors.length,
      syncLogId: syncLogId || 0,
      ...(syncLogError !== null && { syncLogError }),
    })
  } catch (error) {
    console.error('[RSS Sync] Unhandled error:', error)

    // Use serializeError so PostgrestError-shaped objects from supabase-js
    // (which are NOT `instanceof Error`) keep their message + hint + details
    // instead of degrading to "Unknown error".
    const serialized = serializeError(error)

    await logError('rss-sync', serialized.message, {
      ...(serialized.details && { error: serialized.details }),
      ...(syncLogId && { syncLogId }),
    })

    if (syncLogId) {
      try {
        await supabase
          .from('sync_logs')
          .update({
            status: 'error',
            completed_at: new Date().toISOString(),
            error_message: serialized.message,
            ...(serialized.details && { metadata: { error: serialized.details } }),
          })
          .eq('id', syncLogId)
      } catch (e) {
        console.error('[RSS Sync] Failed to update error log:', e)
      }
    }

    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
