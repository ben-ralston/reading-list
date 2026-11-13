import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { enrichOneBook, type BookRow } from './book-covers-backfill'
import * as resolver from '@/lib/book-covers/resolve'

// Minimal supabase fake recording content_items.update({...}).is(col,val).eq('id', id)
function makeSupabase() {
  const updates: { payload: Record<string, unknown>; id: unknown }[] = []
  const supabase = {
    from(table: string) {
      expect(table).toBe('content_items')
      return {
        update(payload: Record<string, unknown>) {
          const chain = {
            is(_col: string, _val: unknown) {
              return chain
            },
            eq(_col: string, id: unknown) {
              updates.push({ payload, id })
              return Promise.resolve({ error: null })
            },
          }
          return chain
        },
      }
    },
  } as unknown as SupabaseClient
  return { supabase, updates }
}

const ROW: BookRow = { id: 7, title: 'Snow Crash', author: 'Neal Stephenson', isbn13: null, imageUrl: null }

describe('enrichOneBook', () => {
  beforeEach(() => {
    vi.spyOn(resolver, 'resolveBookCover')
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes image_url and isbn13 when a cover is resolved for a book with no isbn', async () => {
    vi.mocked(resolver.resolveBookCover).mockResolvedValue({
      imageUrl: 'https://covers.openlibrary.org/b/id/1-L.jpg',
      isbn13: '9780802138256',
      source: 'openlibrary',
    })
    const { supabase, updates } = makeSupabase()
    const result = await enrichOneBook(ROW, supabase, { dryRun: false })
    expect(result.action).toBe('enriched')
    expect(updates).toHaveLength(1)
    expect(updates[0]).toEqual({
      payload: { image_url: 'https://covers.openlibrary.org/b/id/1-L.jpg', isbn13: '9780802138256' },
      id: 7,
    })
  })

  it('never overwrites an existing isbn13 — sets only image_url', async () => {
    vi.mocked(resolver.resolveBookCover).mockResolvedValue({
      imageUrl: 'https://covers.openlibrary.org/b/id/1-L.jpg',
      isbn13: '9780000000001',
      source: 'openlibrary',
    })
    const { supabase, updates } = makeSupabase()
    const result = await enrichOneBook({ ...ROW, isbn13: '9781111111111' }, supabase, { dryRun: false })
    expect(result.action).toBe('enriched')
    expect(updates[0]).toEqual({ payload: { image_url: 'https://covers.openlibrary.org/b/id/1-L.jpg' }, id: 7 })
  })

  it('sets only image_url when the resolver returns no isbn13', async () => {
    vi.mocked(resolver.resolveBookCover).mockResolvedValue({
      imageUrl: 'https://books.google.com/x?img=1',
      isbn13: null,
      source: 'google',
    })
    const { supabase, updates } = makeSupabase()
    await enrichOneBook(ROW, supabase, { dryRun: false })
    expect(updates[0]).toEqual({ payload: { image_url: 'https://books.google.com/x?img=1' }, id: 7 })
  })

  it('does not write in dry-run mode', async () => {
    vi.mocked(resolver.resolveBookCover).mockResolvedValue({
      imageUrl: 'https://books.google.com/x?img=1',
      isbn13: null,
      source: 'google',
    })
    const { supabase, updates } = makeSupabase()
    const result = await enrichOneBook(ROW, supabase, { dryRun: true })
    expect(result.action).toBe('enriched')
    expect(updates).toHaveLength(0)
  })

  it('returns no-cover-found and writes nothing when no cover is resolved', async () => {
    vi.mocked(resolver.resolveBookCover).mockResolvedValue(null)
    const { supabase, updates } = makeSupabase()
    const result = await enrichOneBook(ROW, supabase, { dryRun: false })
    expect(result.action).toBe('no-cover-found')
    expect(updates).toHaveLength(0)
  })

  it('replaces a hot-link-blocked cover (non-null image_url) without the IS NULL guard', async () => {
    // A book whose cover is an Amazon/Goodreads host (HTTP 403 when hot-linked)
    // must be REPLACED. Guarding the UPDATE with .is('image_url', null) would
    // never match the non-null row, so the broken cover would persist forever.
    vi.mocked(resolver.resolveBookCover).mockResolvedValue({
      imageUrl: 'https://covers.openlibrary.org/b/id/9-L.jpg',
      isbn13: null,
      source: 'openlibrary',
    })
    const calls: { payload?: Record<string, unknown>; idEq?: unknown; nullGuard: boolean } = { nullGuard: false }
    const supabase = {
      from() {
        return {
          update(payload: Record<string, unknown>) {
            calls.payload = payload
            const chain = {
              is(col: string, val: unknown) {
                if (col === 'image_url' && val === null) calls.nullGuard = true
                return chain
              },
              eq(col: string, val: unknown) {
                if (col === 'id') calls.idEq = val
                return Promise.resolve({ error: null })
              },
            }
            return chain
          },
        }
      },
    } as unknown as SupabaseClient
    const brokenRow: BookRow = {
      id: 42,
      title: 'Blindsight',
      author: 'Peter Watts',
      isbn13: null,
      imageUrl: 'https://images-na.ssl-images-amazon.com/images/S/x.jpg',
    }
    const result = await enrichOneBook(brokenRow, supabase, { dryRun: false })
    expect(result.action).toBe('enriched')
    expect(calls.payload).toEqual({ image_url: 'https://covers.openlibrary.org/b/id/9-L.jpg' })
    expect(calls.idEq).toBe(42)
    expect(calls.nullGuard).toBe(false)
  })
})

describe('findBooksNeedingCover', () => {
  it('selects books with no cover OR a hot-link-blocked host, and returns the current image_url', async () => {
    let orArg = ''
    const rows = [
      { id: 1, title: 'No Cover', author: 'A', isbn13: null, image_url: null },
      { id: 2, title: 'Broken', author: 'B', isbn13: '9780000000001', image_url: 'https://images-na.ssl-images-amazon.com/x.jpg' },
    ]
    const query = {
      eq() { return query },
      or(arg: string) { orArg = arg; return query },
      order() { return query },
      limit() { return query },
      then(resolve: (v: unknown) => void) { resolve({ data: rows, error: null }) },
    }
    const supabase = {
      from() {
        return { select() { return query } }
      },
    } as unknown as SupabaseClient

    const { findBooksNeedingCover } = await import('./book-covers-backfill')
    const result = await findBooksNeedingCover(supabase)
    // null covers AND amazon/goodreads-hosted covers are both selected
    expect(orArg).toContain('image_url.is.null')
    expect(orArg.toLowerCase()).toContain('amazon')
    expect(orArg.toLowerCase()).toContain('goodreads')
    // Goodreads also serves covers from *.gr-assets.com (no "goodreads" substring)
    expect(orArg.toLowerCase()).toContain('gr-assets')
    expect(result).toEqual([
      { id: 1, title: 'No Cover', author: 'A', isbn13: null, imageUrl: null },
      { id: 2, title: 'Broken', author: 'B', isbn13: '9780000000001', imageUrl: 'https://images-na.ssl-images-amazon.com/x.jpg' },
    ])
  })
})
