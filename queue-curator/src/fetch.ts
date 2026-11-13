// Read-only Supabase access for the curator. PostgREST silently truncates a
// response at its row limit (1,000 here), so every list is read by key:
// "rows after this id", until a page comes back empty. Unlike offset paging
// this cannot skip or repeat a row when items change mid-read, and it does
// not depend on knowing the server's row limit.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { HistoryRow, ItemRow } from './digest'

type Page<T> = { data: T[] | null; error: unknown }

export async function fetchAllByKey<T extends { id: number }>(
  page: (afterId: number, limit: number) => PromiseLike<Page<T>>,
  pageSize = 1000,
): Promise<T[]> {
  const rows: T[] = []
  for (let afterId = 0; ; ) {
    const { data, error } = await page(afterId, pageSize)
    if (error) {
      const message = (error as { message?: unknown }).message
      throw new Error(`queue-curator read failed: ${typeof message === 'string' ? message : String(error)}`)
    }
    if (!data || data.length === 0) return rows
    rows.push(...data)
    afterId = data[data.length - 1].id
  }
}

const ITEM_COLUMNS =
  'id, title, author, status, progress, published_on, created_at, status_changed_at, added_by, ' +
  'duration_seconds, word_count, summary, summary_data, sources:content_sources(platform, source_label, link)'
// Added by migration 20261109000000. The dry run leaves them out so it works
// against a database that does not have the migration yet.
const SHORTLIST_COLUMNS = ', pinned_at, shortlist_dismissed_at'

// Same definition of "active" as fetchActiveItems in lib/content/queue-route.ts.
export function fetchActiveItemRows(db: SupabaseClient, opts: { withShortlistColumns?: boolean } = {}): Promise<ItemRow[]> {
  const columns = ITEM_COLUMNS + (opts.withShortlistColumns ? SHORTLIST_COLUMNS : '')
  return fetchAllByKey<ItemRow>((afterId, limit) =>
    db
      .from('content_items')
      .select(columns)
      .eq('kind', 'feed')
      .neq('status', 'Completed')
      .neq('status', 'Skip')
      .neq('title', '')
      .gt('id', afterId)
      .order('id', { ascending: true })
      .limit(limit) as unknown as PromiseLike<Page<ItemRow>>,
  )
}

export function fetchHistoryRows(db: SupabaseClient): Promise<HistoryRow[]> {
  return fetchAllByKey<HistoryRow & { id: number }>((afterId, limit) =>
    db
      .from('content_items')
      .select('id, title, author, status, status_changed_at')
      .eq('kind', 'feed')
      .in('status', ['Completed', 'Skip'])
      .gt('id', afterId)
      .order('id', { ascending: true })
      .limit(limit) as unknown as PromiseLike<Page<HistoryRow & { id: number }>>,
  )
}
