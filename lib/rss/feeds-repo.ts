import { supabase } from '@/lib/supabase'
import type { FeedType } from './detect'

/** How a feed got into rss_feeds: hand-added/seeded vs. auto-imported from Substack. */
export type FeedSource = 'manual' | 'substack_auto'

export interface RssFeed {
  id: number
  url: string
  label: string
  authorName: string | null
  platform: string
  feedType: FeedType
  active: boolean
  source: FeedSource
  createdAt: string
  updatedAt: string
  lastFetchedAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  lastErrorAt: string | null
  lastItemCount: number | null
  consecutiveErrors: number
  /** Opt-in first-poll backfill window in days; null = off (#164). */
  backfillDays: number | null
}

interface RssFeedRow {
  id: number
  url: string
  label: string
  author_name: string | null
  platform: string
  feed_type: FeedType
  active: boolean
  source: FeedSource
  created_at: string
  updated_at: string
  last_fetched_at: string | null
  last_success_at: string | null
  last_error: string | null
  last_error_at: string | null
  last_item_count: number | null
  consecutive_errors: number
  backfill_days: number | null
}

function rowToFeed(r: RssFeedRow): RssFeed {
  return {
    id: r.id,
    url: r.url,
    label: r.label,
    authorName: r.author_name,
    platform: r.platform,
    feedType: r.feed_type,
    active: r.active,
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastFetchedAt: r.last_fetched_at,
    lastSuccessAt: r.last_success_at,
    lastError: r.last_error,
    lastErrorAt: r.last_error_at,
    lastItemCount: r.last_item_count,
    consecutiveErrors: r.consecutive_errors,
    backfillDays: r.backfill_days,
  }
}

export async function listFeeds(opts?: { includeDisabled?: boolean }): Promise<RssFeed[]> {
  let query = supabase.from('rss_feeds').select('*').order('label', { ascending: true })
  if (!opts?.includeDisabled) query = query.eq('active', true)
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return (data as RssFeedRow[]).map(rowToFeed)
}

export interface InsertFeedInput {
  url: string
  label: string
  authorName: string | null
  platform: string
  feedType: FeedType
  /** Defaults to 'manual'. The Substack importer passes 'substack_auto'. */
  source?: FeedSource
  /** Opt-in first-poll backfill window in days; omit/null = off (#164). */
  backfillDays?: number | null
}

export async function insertFeed(input: InsertFeedInput): Promise<RssFeed> {
  const { data, error } = await supabase
    .from('rss_feeds')
    .insert({
      url: input.url,
      label: input.label,
      author_name: input.authorName,
      platform: input.platform,
      feed_type: input.feedType,
      source: input.source ?? 'manual',
      ...(input.backfillDays != null && { backfill_days: input.backfillDays }),
    })
    .select('*')
    .single()
  if (error) throw new Error(error.message)
  return rowToFeed(data as RssFeedRow)
}

export type FeedPatch = Partial<{
  active: boolean
  label: string
  authorName: string | null
  platform: string
}>

/** Returns the updated feed, or null if no row matched `id`. */
export async function updateFeed(id: number, patch: FeedPatch): Promise<RssFeed | null> {
  const dbPatch: Record<string, unknown> = {}
  if ('active' in patch) dbPatch.active = patch.active
  if ('label' in patch) dbPatch.label = patch.label
  if ('authorName' in patch) dbPatch.author_name = patch.authorName
  if ('platform' in patch) dbPatch.platform = patch.platform

  const { data, error } = await supabase
    .from('rss_feeds')
    .update(dbPatch)
    .eq('id', id)
    .select('*')
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data ? rowToFeed(data as RssFeedRow) : null
}

export async function recordFeedSuccess(id: number, itemCount: number): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('rss_feeds')
    .update({
      last_fetched_at: now,
      last_success_at: now,
      last_item_count: itemCount,
      last_error: null,
      last_error_at: null,
      consecutive_errors: 0,
    })
    .eq('id', id)
  if (error) console.error('[feeds-repo] recordFeedSuccess failed:', id, error.message)
}

/**
 * Record a per-feed failure. `advanceCutoff` also moves last_success_at to
 * now: used when the sync deliberately skipped the feed's items (sanity guard,
 * #287) so the same items don't re-trip the guard on every run. The feed still
 * shows as erroring; the skipped items are recoverable via the backfill tool.
 */
export async function recordFeedError(
  id: number,
  message: string,
  options: { advanceCutoff?: boolean } = {}
): Promise<void> {
  const now = new Date().toISOString()
  // Read current count first so we can increment. A small race with a
  // concurrent run is acceptable here — the counter only drives a UI badge.
  const { data } = await supabase
    .from('rss_feeds')
    .select('consecutive_errors')
    .eq('id', id)
    .maybeSingle()
  const next = ((data?.consecutive_errors as number | undefined) ?? 0) + 1
  const { error } = await supabase
    .from('rss_feeds')
    .update({
      last_fetched_at: now,
      ...(options.advanceCutoff && { last_success_at: now }),
      last_error: message,
      last_error_at: now,
      consecutive_errors: next,
    })
    .eq('id', id)
  if (error) console.error('[feeds-repo] recordFeedError failed:', id, error.message)
}
