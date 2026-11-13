/**
 * Smart queue placement based on engagement scores
 *
 * Maps a score to a RANK in the queue (not a literal queue_position — positions
 * have gaps, see place_item_in_queue's p_target_rank):
 * - Score +1.0 (always completed) → near front of queue (rank 2)
 * - Score  0.0 (unknown author)   → middle of queue
 * - Score -1.0 (always skipped)   → end of queue
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { getEngagementScore } from './engagement'

/**
 * Map an engagement score (-1.0 to +1.0) to a 1-based queue rank.
 *
 * Linear mapping: rank = 2 + round((1 - score) / 2 * (queueSize - 1))
 * Clamped to [2, queueSize + 1]. Pass it to place_item_in_queue as
 * p_target_rank, never as p_target_position.
 */
export function scoreToRank(score: number, queueSize: number): number {
  if (queueSize <= 0) return 2

  const raw = 2 + Math.round(((1 - score) / 2) * (queueSize - 1))
  return Math.max(2, Math.min(raw, queueSize + 1))
}

/**
 * Insert an item at a smart queue rank based on engagement scoring.
 *
 * 1. Computes the engagement score for the item
 * 2. Counts the queue (within this kind) — an exact head count, so no
 *    PostgREST row cap
 * 3. Maps score to a rank via scoreToRank
 * 4. place_item_in_queue resolves the rank to a live position under the
 *    content_items:multirow lock (positions have gaps), shifts items at/after
 *    it down by 1 and places the item there — atomically (#203 RLV-004).
 *
 * The count is read outside the lock: a concurrent placement can only nudge
 * the score→rank mapping by a slot, never produce duplicates.
 *
 * Returns the queue_position the item was placed at.
 */
export async function insertAtSmartPosition(
  itemId: number,
  title: string,
  author: string,
  supabase: SupabaseClient,
  manuallyRequested?: boolean,
  // Books mode (#147): scope the queue-size count + the position shift to
  // a single kind, so inserting a book never renumbers feed items (and vice
  // versa). Defaults to 'feed' for backwards compatibility — all pre-existing
  // callers don't pass kind.
  kind: 'feed' | 'book' = 'feed'
): Promise<number> {
  let rank: number
  let positionConfirmed: boolean

  if (manuallyRequested) {
    // User explicitly requested this item — place right behind the top item
    rank = 2
    positionConfirmed = true
  } else {
    const score = await getEngagementScore(title, author, supabase)

    // Get total queue size (within this kind)
    const { count, error: countError } = await supabase
      .from('content_items')
      .select('id', { count: 'exact', head: true })
      .eq('kind', kind)
      .not('queue_position', 'is', null)

    if (countError) {
      console.error('[Queue Position] Error counting queue items:', countError)
      throw countError
    }

    rank = scoreToRank(score, count ?? 0)
    positionConfirmed = false
  }

  const { data: placedAt, error: placeError } = await supabase.rpc('place_item_in_queue', {
    p_item_id: itemId,
    p_kind: kind,
    p_target_position: null,
    p_target_rank: rank,
    p_position_confirmed: positionConfirmed,
  })

  if (placeError) {
    console.error('[Queue Position] Error placing item:', placeError)
    throw placeError
  }

  return placedAt as number
}
