/**
 * Spotify back-catalog cleanup (#305).
 *
 * Following "This American Life Partners" dumped ~220 decades-old episodes
 * into the queue before the sync's back-catalog guard (lib/spotify/back-catalog.ts)
 * existed. This selects the dump's never-touched imports so
 * scripts/spotify-backcatalog-cleanup.ts can remove them via the
 * remove_content_items RPC (deletes sources first, closes queue gaps, takes
 * the multi-row writer lock).
 *
 * Only rows the sync created (added_by 'spotify'), with no status, progress,
 * confirmed position or pin, are selected; the RPC then skips any row whose
 * updated_at moved since this read, so a concurrent sync or user action wins.
 *
 * Deleting rather than marking 'Skip' is deliberate: the items were never
 * engaged with, and a deleted episode the user later plays is re-imported with
 * its progress (the guard never skips played episodes), whereas a Skip row
 * would absorb that progress and stay archived.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface BackCatalogCriteria {
  /** content_items.author values (the normalized Spotify show names). */
  shows: string[]
  /** Only items created at/after this instant — the dump, not earlier imports. */
  importedSince: string
  /** Only episodes published strictly before this instant; recent ones stay. */
  publishedBefore: string
}

export interface BackCatalogRow {
  id: number
  title: string
  author: string
  kind: string
  added_by: string | null
  status: string
  progress: string | null
  queue_position: number | null
  position_confirmed: boolean
  /** "Make next" pin (#377): protected like a confirmed position. */
  pinned_at: string | null
  published_on: string | null
  created_at: string
  /** Passed back to remove_content_items so rows changed since this read survive. */
  updated_at: string
}

const PAGE_SIZE = 1000 // PostgREST caps list responses at 1000 rows

/** Only rows the Spotify sync created — never a manual add in the same window. */
const SYNC_ADDED_BY = 'spotify'

function isUntouched(row: BackCatalogRow): boolean {
  if (row.status !== '') return false
  // A confirmed position means the user deliberately queued it (drag/reorder).
  if (row.position_confirmed) return false
  // So does a pin (#377), the feed's replacement for a confirmed position.
  if (row.pinned_at) return false
  const progress = (row.progress ?? '').trim()
  return progress === '' || Number(progress) === 0
}

/** Pure filter: the dump's never-touched, older-than-cutoff feed imports. */
export function selectBackCatalogImports(
  rows: BackCatalogRow[],
  criteria: BackCatalogCriteria
): BackCatalogRow[] {
  const shows = new Set(criteria.shows)
  const importedSince = Date.parse(criteria.importedSince)
  const publishedBefore = Date.parse(criteria.publishedBefore)
  return rows.filter((row) => {
    if (!shows.has(row.author) || row.kind !== 'feed') return false
    if (row.added_by !== SYNC_ADDED_BY) return false
    if (Date.parse(row.created_at) < importedSince) return false
    if (!row.published_on || !(Date.parse(row.published_on) < publishedBefore)) return false
    return isUntouched(row)
  })
}

/** Read candidate rows (paged past the 1000-row cap) and apply the filter. */
export async function findBackCatalogImports(
  supabase: SupabaseClient,
  criteria: BackCatalogCriteria
): Promise<BackCatalogRow[]> {
  const rows: BackCatalogRow[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('content_items')
      .select(
        'id, title, author, kind, added_by, status, progress, queue_position, position_confirmed, pinned_at, published_on, created_at, updated_at'
      )
      .in('author', criteria.shows)
      .gte('created_at', criteria.importedSince)
      .eq('kind', 'feed')
      .eq('added_by', SYNC_ADDED_BY)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    rows.push(...((data ?? []) as BackCatalogRow[]))
    if (!data || data.length < PAGE_SIZE) break
  }
  return selectBackCatalogImports(rows, criteria)
}
