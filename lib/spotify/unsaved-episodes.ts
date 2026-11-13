/**
 * Unsaved queue episodes for the Spotify sync (#329).
 *
 * spotify-sync reads progress from /me/episodes (Your Episodes), but Spotify
 * removes an episode from Your Episodes once it is fully played. An episode
 * that drops out before a sync sees it finished never reports its completion,
 * and its queue item stays In Progress forever.
 *
 * This finds the Spotify episodes attached to items still in the queue that
 * are missing from the saved list, and fetches them directly — resume points
 * included — so the ordinary progress path can complete them.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchEpisodes, type SavedEpisode } from './client'

/** PostgREST caps list responses at 1000 rows; page at that size. */
export const UNSAVED_PAGE_SIZE = 1000

const EPISODE_EXTERNAL_ID = /^spotify:episode:([A-Za-z0-9]+)$/

/**
 * Episodes of active queue items (not Completed, Skip or Awaiting comments)
 * that are not in the saved list, shaped like /me/episodes items. Restored
 * items are left out: their episode can still read fully played, and
 * resyncing it would re-archive what was just put back. The episodes are
 * not saved, so added_at is empty.
 *
 * @throws on a content_sources read error or a SpotifyApiError
 */
export async function fetchUnsavedQueueEpisodes(
  accessToken: string,
  savedEpisodes: SavedEpisode[],
  supabase: SupabaseClient
): Promise<SavedEpisode[]> {
  const savedIds = new Set(savedEpisodes.map((s) => s.episode?.id))
  const unsavedIds = new Set<string>()

  for (let from = 0; ; from += UNSAVED_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('content_sources')
      .select('external_id, content_items!inner(status)')
      .eq('platform', 'Spotify')
      .not('content_items.status', 'in', '("Completed","Skip","Awaiting comments")')
      .or('added_by.is.null,added_by.neq.Restored', { referencedTable: 'content_items' })
      .order('id')
      .range(from, from + UNSAVED_PAGE_SIZE - 1)
    if (error) throw error

    for (const row of data ?? []) {
      const id = EPISODE_EXTERNAL_ID.exec(row.external_id ?? '')?.[1]
      if (id && !savedIds.has(id)) unsavedIds.add(id)
    }
    if (!data || data.length < UNSAVED_PAGE_SIZE) break
  }

  if (unsavedIds.size === 0) return []
  const episodes = await fetchEpisodes([...unsavedIds], accessToken)
  return episodes.map((episode) => ({ added_at: '', episode }))
}
