import { describe, it, expect } from 'vitest'
import {
  BACK_CATALOG_MIN_AGE_DAYS,
  BACK_CATALOG_MIN_SHOW_COUNT,
  isBackCatalogCandidate,
  partitionBackCatalog,
} from './back-catalog'
import { UNKNOWN_SHOW_NAME } from './transform'
import type { SyncItem } from '@/lib/sync/matching'

const SAVED_AT = '2026-09-23T14:10:00Z'

function item(overrides: Partial<SyncItem> = {}): SyncItem {
  return {
    title: 'Episode',
    author: 'This American Life Partners',
    platform: 'Spotify',
    externalId: `spotify:episode:${Math.random().toString(36).slice(2)}`,
    publishedOn: '1997-05-02T12:00:00Z',
    savedAt: SAVED_AT,
    ...overrides,
  }
}

describe('isBackCatalogCandidate', () => {
  it('flags an unplayed episode released long before it was saved', () => {
    expect(isBackCatalogCandidate(item())).toBe(true)
  })

  it('does not flag an episode released shortly before it was saved', () => {
    expect(isBackCatalogCandidate(item({ publishedOn: '2026-09-20T12:00:00Z' }))).toBe(false)
  })

  it('uses a strict age threshold of BACK_CATALOG_MIN_AGE_DAYS', () => {
    const saved = Date.parse(SAVED_AT)
    const day = 86_400_000
    const justInside = new Date(saved - BACK_CATALOG_MIN_AGE_DAYS * day + 1000).toISOString()
    const justOutside = new Date(saved - BACK_CATALOG_MIN_AGE_DAYS * day - 1000).toISOString()
    expect(isBackCatalogCandidate(item({ publishedOn: justInside }))).toBe(false)
    expect(isBackCatalogCandidate(item({ publishedOn: justOutside }))).toBe(true)
  })

  it('never flags an episode the user has played', () => {
    expect(isBackCatalogCandidate(item({ status: 'In Progress', progress: '40' }))).toBe(false)
    expect(isBackCatalogCandidate(item({ status: 'Completed', progress: '100' }))).toBe(false)
  })

  it('does not flag when either date is missing or unparseable', () => {
    expect(isBackCatalogCandidate(item({ publishedOn: undefined }))).toBe(false)
    expect(isBackCatalogCandidate(item({ savedAt: undefined }))).toBe(false)
    expect(isBackCatalogCandidate(item({ savedAt: 'not a date' }))).toBe(false)
  })
})

describe('partitionBackCatalog', () => {
  it('skips a show whose back catalog arrives as a batch', () => {
    const dump = Array.from({ length: BACK_CATALOG_MIN_SHOW_COUNT }, (_, i) =>
      item({ title: `${i}: Old episode` })
    )
    const result = partitionBackCatalog(dump)
    expect(result.keep).toEqual([])
    expect(result.skipped).toHaveLength(BACK_CATALOG_MIN_SHOW_COUNT)
    expect(result.skippedByShow).toEqual({
      'This American Life Partners': BACK_CATALOG_MIN_SHOW_COUNT,
    })
  })

  it('keeps a single deliberately saved old episode', () => {
    const lone = item({ author: 'Radiolab', title: 'An old favorite' })
    const result = partitionBackCatalog([lone])
    expect(result.keep).toEqual([lone])
    expect(result.skipped).toEqual([])
    expect(result.skippedByShow).toEqual({})
  })

  it('keeps a few old saves from one show below the threshold', () => {
    const few = Array.from({ length: BACK_CATALOG_MIN_SHOW_COUNT - 1 }, (_, i) =>
      item({ author: 'Radiolab', title: `Old ${i}` })
    )
    expect(partitionBackCatalog(few).keep).toHaveLength(BACK_CATALOG_MIN_SHOW_COUNT - 1)
  })

  it('counts already-imported saved episodes, so a trickling back catalog is still caught', () => {
    // Earlier runs imported part of the archive; this run only sees 2 new ones.
    const alreadyImported = Array.from({ length: BACK_CATALOG_MIN_SHOW_COUNT }, (_, i) =>
      item({ title: `${i}: Imported earlier` })
    )
    const trickle = [item({ title: '301: New arrival' }), item({ title: '302: New arrival' })]

    const result = partitionBackCatalog(trickle, [...alreadyImported, ...trickle])

    expect(result.keep).toEqual([])
    expect(result.skipped).toEqual(trickle)
    expect(result.skippedByShow).toEqual({ 'This American Life Partners': 2 })
  })

  it('never pools shows without a name into a fake dump', () => {
    const nameless = Array.from({ length: BACK_CATALOG_MIN_SHOW_COUNT + 1 }, (_, i) =>
      item({ author: UNKNOWN_SHOW_NAME, title: `Unrelated ${i}` })
    )
    expect(partitionBackCatalog(nameless).keep).toEqual(nameless)
  })

  it("keeps a dumped show's recent and played episodes, and other shows untouched", () => {
    const dump = Array.from({ length: BACK_CATALOG_MIN_SHOW_COUNT + 2 }, (_, i) =>
      item({ title: `${i}: Old episode` })
    )
    const recent = item({ title: '898: An Argument', publishedOn: '2026-09-26T12:00:00Z', savedAt: '2026-09-26T13:00:00Z' })
    const played = item({ title: '12: Old but played', status: 'In Progress', progress: '30' })
    const otherShow = item({ author: 'Hard Fork', title: 'New thing', publishedOn: '2026-09-25T12:00:00Z' })

    const result = partitionBackCatalog([dump[0], recent, ...dump.slice(1), played, otherShow])

    expect(result.keep).toEqual([recent, played, otherShow])
    expect(result.skipped).toHaveLength(dump.length)
    expect(result.skippedByShow).toEqual({ 'This American Life Partners': dump.length })
  })
})
