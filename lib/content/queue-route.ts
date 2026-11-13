// Shared handlers for the per-kind active queue routes (#147).
//
// /api/queue (kind='feed') and /api/books (kind='book') have identical logic
// except for: which kind they filter to, what paths to revalidate, the log
// prefix, and an optional mock-data array. This module is the single
// implementation; the route files are thin parameterizations.
//
// Every database touch is scoped by kind. Reads (SELECT) and the
// queue-position shift inside restoreItem filter on kind directly.
// Single-row UPDATEs chain `.eq('kind', config.kind)` so a POST to
// /api/queue with a book id (or /api/books with a feed id) updates zero
// rows instead of mutating the wrong queue. Batch updates pre-validate
// every id belongs to config.kind before calling batch_update_content_items
// — that RPC is id-only, so the guard has to live here.

import { NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { AWAITING_COMMENTS } from '@/lib/content-status'
import { supabase } from '@/lib/supabase'
import {
  dbToApp,
  type ContentItemWithSourcesDB,
  type ContentKind,
  type QueueItem,
  type FeedHomeData,
} from '@/lib/queue-client'
import { attachEngagementScores, fetchEngagementRows } from '@/lib/content/engagement'
import { articleSource, canConvertCommentsWithAwc, canConvertWithAwc } from '@/lib/awc/eligibility'
import { commentsLink } from '@/lib/comments-link'
import { getActiveForItem, requestConversion } from '@/lib/awc/conversions-repo'
import { fetchLatestCuration } from '@/lib/curation/latest-run'
import { SOURCES_SELECT } from './select'
import { dismissContentItem, pinContentItem, restoreAndPinFeedItem } from './shortlist-writes'

export type { FeedHomeData }

export interface QueueRouteConfig {
  kind: ContentKind
  /** Paths to revalidate after a mutating POST (e.g. ['/'] or ['/books']). */
  revalidatePaths: string[]
  /** Mock data returned when USE_MOCK_DATA=true. Per-route. */
  mockData?: QueueItem[]
  /** Log prefix, e.g. '[Queue API]' or '[Books API]'. */
  logPrefix: string
}

interface CamelCaseUpdate {
  id: number
  status?: string
  queuePosition?: number | null
  positionConfirmed?: boolean
}

function toDbUpdates(updates: CamelCaseUpdate[]): Record<string, unknown>[] {
  const now = new Date().toISOString()
  return updates.map((update) => {
    const dbUpdate: Record<string, unknown> = { id: update.id }
    if ('status' in update) {
      dbUpdate.status = update.status
      dbUpdate.status_changed_at = now
    }
    if ('queuePosition' in update) {
      dbUpdate.queue_position = update.queuePosition
    }
    if ('positionConfirmed' in update) {
      dbUpdate.position_confirmed = update.positionConfirmed
    }
    // RLV-022 (#203): completing/skipping must vacate the queue slot, mirroring
    // updateStatus — the completed_skip_no_position CHECK rejects the row (and
    // 500s the whole batch) otherwise. Overrides any queuePosition in the entry.
    if (update.status === 'Completed' || update.status === 'Skip') {
      dbUpdate.queue_position = null
      dbUpdate.position_confirmed = false
    }
    return dbUpdate
  })
}

const USE_MOCK_DATA = process.env.USE_MOCK_DATA === 'true'

function revalidateAll(paths: string[]): void {
  for (const path of paths) revalidatePath(path)
}

// Shared fetch for the active queue of a kind, used by the GET handler below
// AND the SSR pages (app/page.tsx, app/books/page.tsx) so the first paint and
// the API agree — including the engagement scores (#255) that the client-side
// Recommended sort needs on the SSR payload (the saved-sort hydration re-sort
// runs against it). Throws on item-query failure; engagement is fail-open.
export async function fetchActiveItems(kind: ContentKind): Promise<QueueItem[]> {
  const [rows, engagementRows] = await Promise.all([
    fetchActiveRows(kind),
    fetchEngagementRows(supabase),
  ])
  const items = rows.map(dbToApp)
  return attachEngagementScores(items, engagementRows)
}

// PostgREST caps a response at 1000 rows (#232), so page until a short page.
// The id tiebreaker keeps page boundaries stable; it only orders exact ties.
const ACTIVE_PAGE_SIZE = 1000

async function fetchActiveRows(kind: ContentKind): Promise<ContentItemWithSourcesDB[]> {
  const rows: ContentItemWithSourcesDB[] = []
  for (let offset = 0; ; offset += ACTIVE_PAGE_SIZE) {
    let query = supabase
      .from('content_items')
      .select(SOURCES_SELECT)
      .eq('kind', kind)
      .neq('status', 'Completed')
      .neq('status', 'Skip')
      .neq('title', '')
    // The feed re-sorts client-side (#377), so it pages by id alone: ingest
    // shifts queue_position across many rows, which could move a row between
    // pages mid-read. Books keep their positional first-paint order.
    query = kind === 'feed'
      ? query.order('id', { ascending: true })
      : query
        .order('queue_position', { ascending: true, nullsFirst: false })
        .order('status', { ascending: false })
        .order('published_on', { ascending: false, nullsFirst: false })
        .order('id', { ascending: true })
    const { data, error } = await query.range(offset, offset + ACTIVE_PAGE_SIZE - 1)
    if (error) throw error
    const page = (data ?? []) as ContentItemWithSourcesDB[]
    rows.push(...page)
    if (page.length < ACTIVE_PAGE_SIZE) return rows
  }
}

// What the feed home and /everything need (#377): every active feed item plus
// the latest succeeded curation run. Shared by the SSR pages and GET
// /api/queue so first paint and the API agree; buildShortlist (lib/shortlist)
// turns it into the home order on both. Throws only if the items read fails.
export async function fetchFeedHome(): Promise<FeedHomeData> {
  const [items, curation] = await Promise.all([
    fetchActiveItems('feed'),
    fetchLatestCuration(supabase),
  ])
  return { items, curation }
}

export async function handleQueueGet(config: QueueRouteConfig): Promise<Response> {
  try {
    if (USE_MOCK_DATA && config.mockData) {
      console.log(`${config.logPrefix} Using mock data`)
      return NextResponse.json(
        config.kind === 'feed' ? { items: config.mockData, curation: null } : config.mockData,
      )
    }

    // The feed (#377) returns { items, curation } so home can order the picks;
    // books keep the plain array.
    const body = config.kind === 'feed' ? await fetchFeedHome() : await fetchActiveItems(config.kind)
    // RLV-003 (#189 follow-up): the active queue must never be served from a
    // shared/edge cache. A prior `s-maxage=30, stale-while-revalidate=60` let the
    // Vercel CDN return a pre-mutation queue for 30-90s even though the pages are
    // force-dynamic and the client fetches with cache:'no-store' — a just-completed
    // item kept re-appearing. `no-store` keeps every hop fresh.
    return NextResponse.json(body, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    console.error(`${config.logPrefix} Error fetching data:`, error)
    return NextResponse.json({ error: 'Failed to fetch queue data' }, { status: 500 })
  }
}

export async function handleQueuePost(
  request: Request,
  config: QueueRouteConfig,
): Promise<Response> {
  let action: string | undefined
  try {
    const body = await request.json()
    action = body.action
    const { id, status, progress, queuePosition, positionConfirmed, updates } = body

    if (action !== 'batchUpdate' && (!id || typeof id !== 'number')) {
      return NextResponse.json({ error: 'Invalid or missing ID' }, { status: 400 })
    }

    if (USE_MOCK_DATA) {
      console.log(`${config.logPrefix} Mock update:`, {
        action,
        id,
        status,
        progress,
        queuePosition,
        positionConfirmed,
        updates,
      })
      return NextResponse.json({ success: true })
    }

    switch (action) {
      case 'batchUpdate': {
        if (!Array.isArray(updates) || updates.length === 0) {
          return NextResponse.json({ error: 'Invalid or empty updates array' }, { status: 400 })
        }
        for (const update of updates) {
          if (!update.id || typeof update.id !== 'number') {
            return NextResponse.json({ error: 'Each update must have a valid id' }, { status: 400 })
          }
        }

        // RLV-022 (#203): duplicate ids in one payload are legal (the RPC applies
        // entries in order, last write wins) — compare the ownership count against
        // unique ids so a dup doesn't masquerade as a cross-kind id (#147).
        const uniqueIds = [...new Set(updates.map((u) => u.id as number))]
        const { data: kindCheck, error: kindErr } = await supabase
          .from('content_items')
          .select('id')
          .eq('kind', config.kind)
          .in('id', uniqueIds)

        if (kindErr) {
          console.error(`${config.logPrefix} Error verifying batch kind:`, kindErr)
          throw kindErr
        }

        if (!kindCheck || kindCheck.length !== uniqueIds.length) {
          return NextResponse.json(
            { error: 'One or more items do not belong to this queue' },
            { status: 400 },
          )
        }

        const { error } = await supabase.rpc('batch_update_content_items', {
          updates: toDbUpdates(updates),
        })

        if (error) {
          console.error(`${config.logPrefix} Error in batch update:`, error)
          throw error
        }

        revalidateAll(config.revalidatePaths)
        return NextResponse.json({ success: true, count: updates.length })
      }

      case 'updateStatus': {
        if (typeof status !== 'string') {
          return NextResponse.json({ error: 'Invalid status value' }, { status: 400 })
        }
        const updateData: Record<string, unknown> = {
          status,
          status_changed_at: new Date().toISOString(),
        }
        if (status === 'Completed' || status === 'Skip') {
          updateData.queue_position = null
          updateData.position_confirmed = false
        }

        let query = supabase.from('content_items').update(updateData)
          .eq('id', id).eq('kind', config.kind)
        const isStartToggle = status === '' || status === 'In Progress'
        // A stale page may still offer Start/Not Started after listening finishes.
        // Predicate is evaluated at write time, including after a concurrent sync.
        if (isStartToggle) query = query.neq('status', AWAITING_COMMENTS)
        let { data, error } = isStartToggle
          ? await query.select(SOURCES_SELECT).maybeSingle()
          : await query.select(SOURCES_SELECT).single()
        if (!error && !data) {
          // Return the preserved row for an ignored toggle, or the normal
          // not-found error for a missing/cross-kind ID.
          const current = await supabase.from('content_items').select(SOURCES_SELECT)
            .eq('id', id).eq('kind', config.kind).single()
          data = current.data
          error = current.error
        }

        if (error) {
          console.error(`${config.logPrefix} Error updating status:`, error)
          throw error
        }

        revalidateAll(config.revalidatePaths)
        return NextResponse.json(dbToApp(data as ContentItemWithSourcesDB))
      }

      case 'updateProgress': {
        if (typeof progress !== 'string') {
          return NextResponse.json({ error: 'Invalid progress value' }, { status: 400 })
        }
        const { data, error } = await supabase
          .from('content_items')
          .update({ progress })
          .eq('id', id)
          .eq('kind', config.kind)
          .select(SOURCES_SELECT)
          .single()

        if (error) {
          console.error(`${config.logPrefix} Error updating progress:`, error)
          throw error
        }

        revalidateAll(config.revalidatePaths)
        return NextResponse.json(dbToApp(data as ContentItemWithSourcesDB))
      }

      case 'updatePositionConfirmed': {
        if (typeof positionConfirmed !== 'boolean') {
          return NextResponse.json({ error: 'Invalid positionConfirmed value' }, { status: 400 })
        }
        const { data, error } = await supabase
          .from('content_items')
          .update({ position_confirmed: positionConfirmed })
          .eq('id', id)
          .eq('kind', config.kind)
          .select(SOURCES_SELECT)
          .single()

        if (error) {
          console.error(`${config.logPrefix} Error updating position confirmed:`, error)
          throw error
        }

        revalidateAll(config.revalidatePaths)
        return NextResponse.json(dbToApp(data as ContentItemWithSourcesDB))
      }

      case 'markSentToReader': {
        // #171: record that the item was handed off to ElevenReader. Kind-scoped
        // like every other single-row update so a mismatched POST updates 0 rows.
        const { data, error } = await supabase
          .from('content_items')
          .update({ sent_to_reader_at: new Date().toISOString() })
          .eq('id', id)
          .eq('kind', config.kind)
          .select(SOURCES_SELECT)
          .single()

        if (error) {
          console.error(`${config.logPrefix} Error marking sent to reader:`, error)
          throw error
        }

        revalidateAll(config.revalidatePaths)
        return NextResponse.json(dbToApp(data as ContentItemWithSourcesDB))
      }

      case 'requestAwcConversion': {
        // #317: queue an Askwho Casts conversion for the Mac agent (awc-agent/).
        // Feed-only; same eligibility as the Convert menu item (#364).
        if (config.kind !== 'feed') {
          return NextResponse.json({ error: 'Only feed items can be converted' }, { status: 400 })
        }
        const conversionKind = body.kind ?? 'article'
        if (conversionKind !== 'article' && conversionKind !== 'comments') {
          return NextResponse.json({ error: 'Invalid conversion kind' }, { status: 400 })
        }
        const { data, error } = await supabase
          .from('content_items')
          .select(SOURCES_SELECT)
          .eq('id', id)
          .eq('kind', config.kind)
          .maybeSingle()
        if (error) throw error
        if (!data) {
          return NextResponse.json({ error: 'Item not found' }, { status: 404 })
        }
        const item = dbToApp(data as ContentItemWithSourcesDB)
        const commentsUrl = commentsLink(item.sources)
        const article = articleSource(item)
        const eligible = conversionKind === 'comments'
          ? commentsUrl !== null && canConvertCommentsWithAwc(item, false)
          : !!article?.link && canConvertWithAwc(item, false)
        if (!eligible) {
          return NextResponse.json({ error: 'Item cannot be converted' }, { status: 422 })
        }
        // The article, not item.link: that is Spotify when Spotify is primary.
        const result = conversionKind === 'comments'
          ? await requestConversion(supabase, id, commentsUrl!, 'comments')
          : await requestConversion(supabase, id, article!.link!)
        if (!result.ok) {
          // Return the existing request so the client tracks its real id
          // (another tab/device queued it).
          const conversion = await getActiveForItem(supabase, id)
          return NextResponse.json({ error: 'Already converting', conversion }, { status: 409 })
        }
        revalidateAll(config.revalidatePaths)
        return NextResponse.json(result.conversion)
      }

      case 'pin':
      case 'dismiss': {
        // #377: "Make next" pins, "Not now" sends it back to the pile.
        if (config.kind !== 'feed') {
          return NextResponse.json({ error: 'Only feed items can be pinned' }, { status: 400 })
        }
        const row = action === 'pin'
          ? await pinContentItem(supabase, id)
          : await dismissContentItem(supabase, id)
        if (!row) {
          return NextResponse.json({ error: 'Item is no longer in the queue' }, { status: 409 })
        }
        revalidateAll(config.revalidatePaths)
        return NextResponse.json(dbToApp(row))
      }

      case 'restoreItem': {
        // #377: on the feed a restore is one guarded update that also pins the
        // item; the feed no longer reads queue positions.
        if (config.kind === 'feed') {
          const row = await restoreAndPinFeedItem(supabase, id)
          if (!row) {
            return NextResponse.json({ error: 'Item not found in this queue' }, { status: 400 })
          }
          revalidateAll(config.revalidatePaths)
          return NextResponse.json(dbToApp(row))
        }
        // Books: restore a completed/skipped item back to its own kind's queue:
        // insert at rank 2 and shift everything else within this kind
        // down by one. Shift + place happen atomically inside the
        // place_item_in_queue RPC (RLV-004 #203) — a JS-side read→shift→write
        // here raced concurrent placements (e.g. the rss-sync cron) and
        // produced duplicate positions. The RPC is also what lets status and
        // queue_position change together (the completed_skip_no_position
        // CHECK forbids a position while status is still 'Completed').
        // Pre-check the target item's kind so a mismatched POST returns
        // 400 instead of touching the queue and failing the restore.
        const { data: target, error: targetErr } = await supabase
          .from('content_items')
          .select('id')
          .eq('id', id)
          .eq('kind', config.kind)
          .maybeSingle()

        if (targetErr) {
          console.error(`${config.logPrefix} Error verifying restore target kind:`, targetErr)
          throw targetErr
        }
        if (!target) {
          return NextResponse.json(
            { error: 'Item not found in this queue' },
            { status: 400 },
          )
        }

        // Rank 2 (right behind the top item), resolved to a live position
        // inside the RPC: the queue can have gaps, so a literal 2 could jump
        // ahead of the top item.
        const { error: placeError } = await supabase.rpc('place_item_in_queue', {
          p_item_id: id,
          p_kind: config.kind,
          p_target_position: null,
          p_target_rank: 2,
          p_position_confirmed: false,
          p_restore: true,
        })

        if (placeError) {
          console.error(`${config.logPrefix} Error restoring item:`, placeError)
          throw placeError
        }

        // Re-read the restored row for the response payload.
        const { data, error } = await supabase
          .from('content_items')
          .select(SOURCES_SELECT)
          .eq('id', id)
          .eq('kind', config.kind)
          .single()

        if (error) {
          console.error(`${config.logPrefix} Error fetching restored item:`, error)
          throw error
        }

        revalidateAll(config.revalidatePaths)
        return NextResponse.json(dbToApp(data as ContentItemWithSourcesDB))
      }

      case 'makeNext': {
        // #377: on the feed, Make next is a pin. Kept here so a tab still
        // running older JS can't write queue positions.
        if (config.kind === 'feed') {
          const row = await pinContentItem(supabase, id)
          if (!row) {
            return NextResponse.json({ error: 'Item is no longer in the queue' }, { status: 409 })
          }
          revalidateAll(config.revalidatePaths)
          return NextResponse.json(dbToApp(row))
        }
        // Books, #229: promote to position 1 atomically on the server. The old
        // client-computed renumber batch trusted the client's queue snapshot;
        // a stale tab promoted an item without renumbering the real position-1
        // holder and minted duplicate positions. The RPC shifts from live DB
        // state inside one transaction, serialized with every other multi-row
        // content_items writer by the content_items:multirow advisory lock (#337).
        const { data: target, error: targetErr } = await supabase
          .from('content_items')
          .select('id')
          .eq('id', id)
          .eq('kind', config.kind)
          .maybeSingle()

        if (targetErr) {
          console.error(`${config.logPrefix} Error verifying makeNext target kind:`, targetErr)
          throw targetErr
        }
        if (!target) {
          return NextResponse.json(
            { error: 'Item not found in this queue' },
            { status: 400 },
          )
        }

        const { error: placeError } = await supabase.rpc('place_item_in_queue', {
          p_item_id: id,
          p_kind: config.kind,
          p_target_position: 1,
          p_position_confirmed: true,
        })

        if (placeError) {
          console.error(`${config.logPrefix} Error promoting item:`, placeError)
          throw placeError
        }

        const { data, error } = await supabase
          .from('content_items')
          .select(SOURCES_SELECT)
          .eq('id', id)
          .eq('kind', config.kind)
          .single()

        if (error) {
          console.error(`${config.logPrefix} Error fetching promoted item:`, error)
          throw error
        }

        revalidateAll(config.revalidatePaths)
        return NextResponse.json(dbToApp(data as ContentItemWithSourcesDB))
      }

      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }
  } catch (error) {
    console.error(
      `${config.logPrefix} Error updating data (action: ${action ?? 'unknown'}):`,
      error,
    )
    return NextResponse.json({ error: 'Failed to update data' }, { status: 500 })
  }
}

// Archive route (GET only). Mirrors the queue handler but filters for
// Completed/Skip and sorts by status_changed_at desc.
export async function handleArchiveGet(config: QueueRouteConfig): Promise<Response> {
  try {
    if (USE_MOCK_DATA && config.mockData) {
      console.log(`${config.logPrefix} Using mock data`)
      return NextResponse.json(config.mockData)
    }

    // #232: PostgREST caps a single response at 1000 rows, and the feed
    // archive is already past that — an uncapped select silently drops the
    // oldest items. Page with .range() until a short page. The id tiebreaker
    // keeps page boundaries stable when rows share a status_changed_at.
    const PAGE_SIZE = 1000
    const rows: ContentItemWithSourcesDB[] = []
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = await supabase
        .from('content_items')
        .select(SOURCES_SELECT)
        .eq('kind', config.kind)
        .or('status.eq.Completed,status.eq.Skip')
        .neq('title', '')
        .order('status_changed_at', { ascending: false, nullsFirst: false })
        .order('updated_at', { ascending: false })
        .order('id', { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1)

      if (error) {
        console.error(`${config.logPrefix} Supabase error:`, error)
        throw error
      }

      const page = (data ?? []) as ContentItemWithSourcesDB[]
      rows.push(...page)
      if (page.length < PAGE_SIZE) break
    }

    const items = rows.map(dbToApp)
    return NextResponse.json(items)
  } catch (error) {
    console.error(`${config.logPrefix} Error fetching data:`, error)
    return NextResponse.json({ error: 'Failed to fetch archive data' }, { status: 500 })
  }
}
