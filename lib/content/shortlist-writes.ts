// The owner's overrides on the feed home shortlist (#377). Each is one guarded,
// kind-scoped single-row update, so none needs the content_items:multirow
// advisory lock. A null result means no row matched the guard (the item was
// archived, restored or deleted meanwhile, or is not a feed item).

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ContentItemWithSourcesDB } from '@/lib/queue-client'
import { SOURCES_SELECT } from './select'

type Row = ContentItemWithSourcesDB | null

async function updateActiveFeedItem(
  client: SupabaseClient,
  id: number,
  fields: Record<string, unknown>,
): Promise<Row> {
  const { data, error } = await client
    .from('content_items')
    .update(fields)
    .eq('id', id)
    .eq('kind', 'feed')
    .neq('status', 'Completed')
    .neq('status', 'Skip')
    .select(SOURCES_SELECT)
    .maybeSingle()
  if (error) throw error
  return (data as Row) ?? null
}

// "Make next" (and hand-adds): top of home, newest pin first.
export function pinContentItem(client: SupabaseClient, id: number): Promise<Row> {
  return updateActiveFeedItem(client, id, {
    pinned_at: new Date().toISOString(),
    shortlist_dismissed_at: null,
  })
}

// "Not now": back to the pile, off home for DISMISS_HOLD_DAYS. Not a skip.
export function dismissContentItem(client: SupabaseClient, id: number): Promise<Row> {
  return updateActiveFeedItem(client, id, {
    pinned_at: null,
    shortlist_dismissed_at: new Date().toISOString(),
  })
}

// Restore from the feed archive (#377: the owner chose to pin restores). Replaces
// place_item_in_queue on the feed, which no longer reads queue positions.
// added_by 'Restored' matches what the RPC writes: the Spotify unsaved-episode
// sync skips Restored items so it doesn't re-archive a played episode.
export async function restoreAndPinFeedItem(client: SupabaseClient, id: number): Promise<Row> {
  const now = new Date().toISOString()
  const { data, error } = await client
    .from('content_items')
    .update({
      status: '',
      status_changed_at: now,
      added_by: 'Restored',
      pinned_at: now,
      shortlist_dismissed_at: null,
      queue_position: null,
      position_confirmed: false,
    })
    .eq('id', id)
    .eq('kind', 'feed')
    .in('status', ['Completed', 'Skip'])
    .select(SOURCES_SELECT)
    .maybeSingle()
  if (error) throw error
  return (data as Row) ?? null
}
