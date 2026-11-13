/**
 * Book-cover backfill (#168): populate image_url on existing book content_items
 * that have no cover (the imported Goodreads library — see issue: 105/106 books
 * had neither a cover nor an ISBN). Covers are resolved from title + author via
 * Open Library / Google Books (lib/book-covers/resolve).
 *
 * Mirrors the feed-card backfill (feed-cards-backfill.ts): select "books with no
 * image_url", resolve a cover, and write it with a `.is('image_url', null)` guard
 * so a re-run is idempotent (enriched rows drop out of the selection → 0 writes).
 * A resolved ISBN-13 is written too, but ONLY when the row doesn't already have
 * one — never clobbering an existing value (matches #186's INSERT-only ISBN
 * semantics). Best-effort: a resolver/DB failure becomes a result, not a throw,
 * so the batch keeps going.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveBookCover } from '@/lib/book-covers/resolve'
import { runConcurrent } from './backfill-pool'

export interface BookRow {
  id: number
  title: string
  author: string
  isbn13: string | null
  /**
   * The row's current cover, if any. null means no cover (the original
   * backfill target). A non-null value here is a hot-link-blocked host
   * (Amazon/Goodreads) that 403s in the browser and must be REPLACED.
   */
  imageUrl: string | null
}

/**
 * Host substrings whose images 403 when hot-linked from the app (so they render
 * as a broken/placeholder cover) and should be re-resolved to a loadable cover.
 * `parseBook` (#186) can store an Amazon/Goodreads thumbnail for new books, and
 * Goodreads serves covers from both `*.goodreads.com` and `*.gr-assets.com`.
 */
const BLOCKED_COVER_HOSTS = ['amazon', 'goodreads', 'gr-assets'] as const

export type BookCoverAction = 'enriched' | 'no-cover-found' | 'failed'

export interface BookEnrichResult {
  id: number
  title: string
  action: BookCoverAction
  imageUrl: string | null
  isbn13: string | null
  source: string | null
}

/**
 * Select books that need a cover: either no cover at all (image_url IS NULL) OR
 * a hot-link-blocked host (Amazon/Goodreads) that must be replaced. Ordered by
 * id for stable, resumable batches. `isbn13` is read so we don't overwrite an
 * existing value; `image_url` is read so the writer can choose the right guard.
 */
export async function findBooksNeedingCover(
  supabase: SupabaseClient,
  limit?: number,
): Promise<BookRow[]> {
  const blockedFilters = BLOCKED_COVER_HOSTS.map((h) => `image_url.ilike.*${h}*`).join(',')
  let query = supabase
    .from('content_items')
    .select('id, title, author, isbn13, image_url')
    .eq('kind', 'book')
    .or(`image_url.is.null,${blockedFilters}`)
    .order('id', { ascending: true })

  if (limit) query = query.limit(limit)

  const { data, error } = await query
  if (error) throw error

  return (data ?? []).map((row) => {
    const r = row as { id: number; title: string; author: string; isbn13: string | null; image_url: string | null }
    return { id: r.id, title: r.title, author: r.author, isbn13: r.isbn13 ?? null, imageUrl: r.image_url ?? null }
  })
}

/**
 * Resolve a cover for one book and (unless dry-run) write it. Sets image_url
 * always, and isbn13 only when resolved AND the row has none. The UPDATE is
 * guarded with `.is('image_url', null)` so a concurrent writer that filled the
 * field first isn't clobbered. Never throws.
 */
export async function enrichOneBook(
  row: BookRow,
  supabase: SupabaseClient,
  opts: { dryRun: boolean },
): Promise<BookEnrichResult> {
  let resolved
  try {
    resolved = await resolveBookCover(row.title, row.author)
  } catch {
    return { id: row.id, title: row.title, action: 'failed', imageUrl: null, isbn13: null, source: null }
  }

  if (!resolved) {
    return { id: row.id, title: row.title, action: 'no-cover-found', imageUrl: null, isbn13: null, source: null }
  }

  const newIsbn13 = resolved.isbn13 && !row.isbn13 ? resolved.isbn13 : null
  const payload: { image_url: string; isbn13?: string } = { image_url: resolved.imageUrl }
  if (newIsbn13) payload.isbn13 = newIsbn13

  if (!opts.dryRun) {
    // NULL-cover rows: guard on image_url IS NULL so a concurrent writer that
    // filled it first isn't clobbered (idempotent re-runs). Hot-link-blocked
    // rows are meant to be REPLACED, so skip that guard — selection-level
    // idempotency still holds because the new (loadable) host drops the row
    // out of the next findBooksNeedingCover query.
    const base = supabase.from('content_items').update(payload)
    const guarded = row.imageUrl == null ? base.is('image_url', null) : base
    const { error } = await guarded.eq('id', row.id)
    if (error) {
      return { id: row.id, title: row.title, action: 'failed', imageUrl: resolved.imageUrl, isbn13: newIsbn13, source: resolved.source }
    }
  }

  return { id: row.id, title: row.title, action: 'enriched', imageUrl: resolved.imageUrl, isbn13: newIsbn13, source: resolved.source }
}

/**
 * Run enrichOneBook over many rows with a small concurrency pool (polite to the
 * cover APIs). Returns results in input order.
 */
export async function enrichBooks(
  rows: BookRow[],
  supabase: SupabaseClient,
  opts: { dryRun: boolean; concurrency?: number },
): Promise<BookEnrichResult[]> {
  return runConcurrent(
    rows,
    (row) => enrichOneBook(row, supabase, { dryRun: opts.dryRun }),
    opts.concurrency ?? 5,
  )
}
