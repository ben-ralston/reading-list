import { describe, it, expect } from 'vitest'
import { planAudibleDedup, type DedupItem } from './audible-dedup'

// Helper: build a DedupItem with sane defaults.
function item(partial: Partial<DedupItem> & { id: number; title: string; author: string }): DedupItem {
  return {
    kind: 'book',
    status: '',
    queue_position: null,
    position_confirmed: false,
    progress: null,
    sources: [],
    ...partial,
  }
}

function goodreadsSource(id: number, link = 'https://www.goodreads.com/book/show/1') {
  return { id, platform: 'Goodreads', external_id: `goodreads:book:${id}`, link, is_primary: true }
}
function audibleSource(id: number, asin = 'B0TEST') {
  return { id, platform: 'Audible', external_id: `audible:book:${asin}`, link: `https://www.audible.com/pd/${asin}`, is_primary: true }
}

describe('planAudibleDedup', () => {
  it('merges a subtitle-divergence pair, keeping the Goodreads (full-title) row', () => {
    const items = [
      item({ id: 1, title: 'Manufacturing Consent: The Political Economy of the Mass Media', author: 'Edward S. Herman', status: '', queue_position: 3, position_confirmed: true, sources: [goodreadsSource(101)] }),
      item({ id: 2, title: 'Manufacturing Consent', author: 'Edward S. Herman', status: '', queue_position: 15, sources: [audibleSource(102, 'B06Y2J6MQZ')] }),
    ]
    const { merges, skipped } = planAudibleDedup(items)
    expect(skipped).toEqual([])
    expect(merges).toHaveLength(1)
    expect(merges[0]).toMatchObject({
      keepId: 1,
      dropId: 2,
      movedSourceIds: [102],
      newStatus: null,       // both queued → unchanged
      clearPosition: false,  // not completed
      newProgress: null,
    })
  })

  it('merges a series-suffix pair', () => {
    const items = [
      item({ id: 1, title: 'Children of Time (Children of Time, #1)', author: 'Adrian Tchaikovsky', sources: [goodreadsSource(101)] }),
      item({ id: 2, title: 'Children of Time', author: 'Adrian Tchaikovsky', sources: [audibleSource(102)] }),
    ]
    const { merges } = planAudibleDedup(items)
    expect(merges).toHaveLength(1)
    expect(merges[0]).toMatchObject({ keepId: 1, dropId: 2 })
  })

  it('reconciles status to Completed and clears the keeper position (Audible authoritative)', () => {
    const items = [
      item({ id: 1, title: 'Children of Time (Children of Time, #1)', author: 'Adrian Tchaikovsky', status: '', queue_position: 7, position_confirmed: true, sources: [goodreadsSource(101)] }),
      item({ id: 2, title: 'Children of Time', author: 'Adrian Tchaikovsky', status: 'Completed', progress: '99', sources: [audibleSource(102)] }),
    ]
    const { merges } = planAudibleDedup(items)
    expect(merges[0]).toMatchObject({
      keepId: 1,
      dropId: 2,
      newStatus: 'Completed',
      clearPosition: true,
      newProgress: null, // do NOT copy the misleading "99" onto a completed book
    })
  })

  it('matches across Goodreads double-space author vs Audible single-space author', () => {
    const items = [
      item({ id: 1, title: 'The Anthropocene Reviewed: Essays on a Human-Centered Planet', author: 'John  Green', status: 'Completed', sources: [goodreadsSource(101)] }),
      item({ id: 2, title: 'The Anthropocene Reviewed', author: 'John Green', status: 'Completed', sources: [audibleSource(102)] }),
    ]
    const { merges, skipped } = planAudibleDedup(items)
    expect(skipped).toEqual([])
    expect(merges).toHaveLength(1)
    expect(merges[0]).toMatchObject({ keepId: 1, dropId: 2, newStatus: null })
  })

  it('leaves an already-merged book (Goodreads + Audible on one row) untouched', () => {
    const items = [
      item({ id: 1, title: 'Project Hail Mary', author: 'Andy Weir', status: 'Completed', sources: [goodreadsSource(101), { id: 102, platform: 'Audible', external_id: 'audible:book:B08G9PRS1K', link: null, is_primary: false }] }),
    ]
    const { merges, skipped } = planAudibleDedup(items)
    expect(merges).toEqual([])
    expect(skipped).toEqual([])
  })

  it('does NOT merge two Goodreads editions (no Audible-only row)', () => {
    const items = [
      item({ id: 1, title: 'Dune', author: 'Frank Herbert', sources: [goodreadsSource(101)] }),
      item({ id: 2, title: 'Dune: Special Edition', author: 'Frank Herbert', sources: [goodreadsSource(102)] }),
    ]
    const { merges, skipped } = planAudibleDedup(items)
    expect(merges).toEqual([])
    expect(skipped).toHaveLength(1)
    expect(skipped[0].itemIds).toEqual([1, 2])
  })

  it('flags (does not auto-merge) an ambiguous group with two Audible-only rows', () => {
    const items = [
      item({ id: 1, title: 'Dune', author: 'Frank Herbert', sources: [goodreadsSource(101)] }),
      item({ id: 2, title: 'Dune: Part One', author: 'Frank Herbert', sources: [audibleSource(102, 'A')] }),
      item({ id: 3, title: 'Dune: Part Two', author: 'Frank Herbert', sources: [audibleSource(103, 'B')] }),
    ]
    const { merges, skipped } = planAudibleDedup(items)
    expect(merges).toEqual([])
    expect(skipped).toHaveLength(1)
  })

  it('ignores non-book kinds', () => {
    const items = [
      item({ id: 1, title: 'Manufacturing Consent: The Political Economy of the Mass Media', author: 'X', kind: 'feed', sources: [goodreadsSource(101)] }),
      item({ id: 2, title: 'Manufacturing Consent', author: 'X', kind: 'feed', sources: [audibleSource(102)] }),
    ]
    const { merges, skipped } = planAudibleDedup(items)
    expect(merges).toEqual([])
    expect(skipped).toEqual([])
  })
})
