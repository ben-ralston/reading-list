import { describe, it, expect, vi } from 'vitest'
import {
  selectBackCatalogImports,
  findBackCatalogImports,
  type BackCatalogCriteria,
  type BackCatalogRow,
} from './spotify-backcatalog-cleanup'

const CRITERIA: BackCatalogCriteria = {
  shows: ['This American Life Partners'],
  importedSince: '2026-09-23T00:00:00Z',
  publishedBefore: '2026-09-01T00:00:00Z',
}

function row(overrides: Partial<BackCatalogRow> = {}): BackCatalogRow {
  return {
    id: 1,
    title: '75: Kindness of Strangers',
    author: 'This American Life Partners',
    kind: 'feed',
    added_by: 'spotify',
    status: '',
    progress: null,
    queue_position: 250,
    position_confirmed: false,
    pinned_at: null,
    published_on: '1997-09-05T12:00:00+00:00',
    created_at: '2026-09-23T14:16:37.756261+00:00',
    updated_at: '2026-09-23T14:16:40.123456+00:00',
    ...overrides,
  }
}

describe('selectBackCatalogImports', () => {
  // #377: a pin gives the same protection as a confirmed position.
  it('keeps a pinned episode', () => {
    expect(selectBackCatalogImports([row({ pinned_at: '2026-11-09T12:00:00Z' })], CRITERIA)).toHaveLength(0)
  })

  it('selects an untouched old episode imported by the dump', () => {
    expect(selectBackCatalogImports([row()], CRITERIA)).toHaveLength(1)
  })

  it('keeps recent episodes of the show', () => {
    const recent = [
      row({ id: 2, title: '449: Middle School', published_on: '2026-09-06T12:00:00+00:00' }),
      row({ id: 3, title: '898: An Argument', published_on: '2026-09-26T12:00:00+00:00' }),
    ]
    expect(selectBackCatalogImports(recent, CRITERIA)).toEqual([])
  })

  it('keeps anything the user has touched', () => {
    const touched = [
      row({ id: 4, status: 'In Progress', progress: '40' }),
      row({ id: 5, status: 'Completed', queue_position: null }),
      row({ id: 6, status: 'Skip', queue_position: null }),
      row({ id: 7, progress: '12' }),
      // Unplayed, but the user accepted it into the queue (dragged/reordered).
      row({ id: 14, position_confirmed: true }),
    ]
    expect(selectBackCatalogImports(touched, CRITERIA)).toEqual([])
  })

  it('treats a "0" or blank progress as untouched', () => {
    const untouched = [row({ id: 8, progress: '0' }), row({ id: 9, progress: '' })]
    expect(selectBackCatalogImports(untouched, CRITERIA).map((r) => r.id)).toEqual([8, 9])
  })

  it('keeps items imported before the dump, from other shows, books, or without a publish date', () => {
    const others = [
      row({ id: 10, created_at: '2026-07-06T01:15:48+00:00' }),
      row({ id: 11, author: 'This American Life' }),
      row({ id: 12, kind: 'book' }),
      row({ id: 13, published_on: null }),
      // Added by hand (share sheet) during the dump window, not by the sync.
      row({ id: 15, added_by: 'share' }),
    ]
    expect(selectBackCatalogImports(others, CRITERIA)).toEqual([])
  })
})

describe('findBackCatalogImports', () => {
  it('pages past the PostgREST 1000-row cap and filters the result', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => row({ id: i + 1 }))
    const page2 = [row({ id: 1001 }), row({ id: 1002, status: 'Skip' })]
    const ranges: [number, number][] = []
    const query: Record<string, unknown> = {}
    for (const name of ['select', 'in', 'gte', 'eq', 'order']) query[name] = vi.fn(() => query)
    query.range = vi.fn(async (from: number, to: number) => {
      ranges.push([from, to])
      return { data: from === 0 ? page1 : page2, error: null }
    })
    const supabase = { from: vi.fn(() => query) }

    const rows = await findBackCatalogImports(supabase as never, CRITERIA)

    expect(ranges).toEqual([[0, 999], [1000, 1999]])
    expect(rows).toHaveLength(1001)
    expect(query.in).toHaveBeenCalledWith('author', CRITERIA.shows)
    expect(query.gte).toHaveBeenCalledWith('created_at', CRITERIA.importedSince)
    expect(query.eq).toHaveBeenCalledWith('added_by', 'spotify')
  })

  it('throws on a query error', async () => {
    const query: Record<string, unknown> = {}
    for (const name of ['select', 'in', 'gte', 'eq', 'order']) query[name] = vi.fn(() => query)
    query.range = vi.fn(async () => ({ data: null, error: { message: 'boom' } }))
    await expect(
      findBackCatalogImports({ from: () => query } as never, CRITERIA)
    ).rejects.toMatchObject({ message: 'boom' })
  })
})
