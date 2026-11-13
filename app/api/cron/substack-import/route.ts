/**
 * Substack Auto-Import Cron Handler (#149 Phase 2)
 *
 * Reads the publications the user subscribes to from their public Substack profile and
 * keeps the `rss_feeds` table in sync with them. This handler only manages feed *rows* —
 * it never fetches articles. New rows are active feeds that the existing `rss-sync` cron
 * ingests on its next run.
 *
 * Schedule: daily (Cloudflare cron-worker). Auth mirrors `rss-sync`.
 */

import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { fetchSubstackSubscriptions, type SubstackSub } from '@/lib/substack/subscriptions'
import { listFeeds, insertFeed, updateFeed } from '@/lib/rss/feeds-repo'
import { getDefaultBackfillDays } from '@/lib/app-settings'
import { detectFeedType } from '@/lib/rss/detect'
import { serializeError } from '@/lib/sync/serialize-error'
import { bearerTokenMatches } from '@/lib/bearer-auth'
import { logError } from '@/lib/logger'

export const dynamic = 'force-dynamic'

const SUBSTACK_IMPORT_SOURCE = 'substack_import'

async function isAuthenticated(request: Request): Promise<boolean> {
  const authHeader = request.headers.get('authorization')
  const apiSecret = process.env.SYNC_API_SECRET
  if (bearerTokenMatches(authHeader, apiSecret)) return true // constant-time (RLV-016)
  try {
    const { getSession } = await import('@/lib/auth')
    const session = await getSession()
    if (session.isAuthenticated) return true
  } catch {
    // Session parsing fails for external callers with no cookies — fall through.
  }
  return false
}

async function logRun(fields: {
  status: 'success' | 'partial' | 'error'
  itemsProcessed?: number
  itemsCreated?: number
  itemsUpdated?: number
  itemsSkipped?: number
  errorMessage?: string
  metadata?: Record<string, unknown>
}): Promise<void> {
  const { error } = await supabase.from('sync_logs').insert({
    source: SUBSTACK_IMPORT_SOURCE,
    status: fields.status,
    completed_at: new Date().toISOString(),
    items_processed: fields.itemsProcessed ?? 0,
    items_created: fields.itemsCreated ?? 0,
    items_updated: fields.itemsUpdated ?? 0,
    items_skipped: fields.itemsSkipped ?? 0,
    ...(fields.errorMessage != null && { error_message: fields.errorMessage }),
    ...(fields.metadata != null && { metadata: fields.metadata }),
  })
  if (error) {
    console.error('[Substack Import] sync_logs insert failed:', error.message)
    await logError('substack-import', error, { blindSpot: 'sync_logs-write' })
  }
}

export async function GET(request: Request) {
  if (!(await isAuthenticated(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const handle = process.env.SUBSTACK_HANDLE?.trim()
  if (!handle) {
    console.warn('[Substack Import] SUBSTACK_HANDLE not configured; skipping')
    return NextResponse.json({ ok: false, error: 'SUBSTACK_HANDLE not configured' })
  }

  // 1. Fetch the public subscription snapshot. A failure here ends the run WITHOUT
  //    mutating any feed — a 429/transient error must never disable a subscription.
  let snapshot: { subs: SubstackSub[]; truncated: boolean }
  try {
    snapshot = await fetchSubstackSubscriptions(handle)
  } catch (e) {
    const { message } = serializeError(e)
    console.error('[Substack Import] subscription fetch failed:', e)
    await logError('substack-import', e)
    await logRun({ status: 'error', errorMessage: message })
    return NextResponse.json({ ok: false, added: 0, disabled: 0, error: message })
  }
  const { subs, truncated } = snapshot

  // 2. Diff against every existing feed (active + disabled).
  const existing = await listFeeds({ includeDisabled: true })
  const existingUrls = new Set(existing.map((f) => f.url))
  const subUrls = new Set(subs.map((s) => s.feedUrl))

  // New feeds adopt the global default backfill window (#164). Read once per run.
  const defaultBackfillDays = await getDefaultBackfillDays()

  // 3. Insert pass — add subscriptions we don't already track.
  let added = 0
  for (const s of subs) {
    if (existingUrls.has(s.feedUrl)) continue
    try {
      await insertFeed({
        url: s.feedUrl,
        label: s.name,
        authorName: s.name,
        platform: 'Substack',
        feedType: detectFeedType(s.feedUrl),
        source: 'substack_auto',
        backfillDays: defaultBackfillDays,
      })
      added++
    } catch (e) {
      // A UNIQUE race (concurrent run, or a manual add mid-run) shouldn't abort the run.
      console.error('[Substack Import] insert failed for', s.feedUrl, e)
    }
  }

  // 4. Disable pass — ONLY on a trustworthy snapshot. An empty or truncated response can't
  //    be trusted to mean "unsubscribed", so we skip disabling entirely. Scope is
  //    substack_auto rows only; manual feeds are never auto-disabled, and we never
  //    re-enable (a manually-disabled-but-still-subscribed feed stays disabled).
  const trustworthy = subs.length > 0 && !truncated
  let disabled = 0
  if (trustworthy) {
    for (const f of existing) {
      if (f.source !== 'substack_auto' || !f.active) continue
      if (subUrls.has(f.url)) continue
      await updateFeed(f.id, { active: false })
      disabled++
    }
  }

  // The fetch succeeded, so the run is a success even when truncated — a truncated
  // snapshot only means we deliberately skipped the disable pass (recorded in metadata).
  // Logging 'partial' here would render as "feeds failed" on /settings/status.
  await logRun({
    status: 'success',
    itemsProcessed: subs.length,
    itemsCreated: added,
    itemsUpdated: disabled,
    itemsSkipped: subs.length - added,
    metadata: { added, disabled, totalSubs: subs.length, truncated, disableSkipped: !trustworthy },
  })

  return NextResponse.json({
    ok: true,
    added,
    disabled,
    totalSubs: subs.length,
    truncated,
    disableSkipped: !trustworthy,
  })
}
