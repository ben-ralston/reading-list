import { describe, it, expect } from 'vitest'
import type { QueueItem } from './queue-client'
import {
  buildShortlist,
  curationFreshness,
  isDismissedWithinHold,
  parseCurationPicks,
  isNewSince,
  DISMISS_HOLD_DAYS,
  HOME_SIZE,
  type Curation,
} from './shortlist'

const NOW = Date.parse('2026-11-09T12:00:00Z')
const HOUR = 3_600_000
const DAY = 86_400_000

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function item(id: number, over: Partial<QueueItem> = {}): QueueItem {
  return {
    id,
    title: `Item ${id}`,
    author: `Author ${id}`,
    publishedOn: null,
    status: '',
    queuePosition: null,
    positionConfirmed: false,
    progress: null,
    addedBy: null,
    // Older ids are older items, so the fallback order is predictable.
    createdAt: iso(NOW - (100 - id) * HOUR),
    updatedAt: iso(NOW),
    statusChangedAt: null,
    kind: 'feed',
    sentToReaderAt: null,
    imageUrl: null,
    wordCount: null,
    durationSeconds: null,
    sources: [],
    platform: '',
    link: '',
    pinnedAt: null,
    shortlistDismissedAt: null,
    ...over,
  }
}

function curation(picks: Array<[number, string | null]>, finishedAt = iso(NOW - HOUR)): Curation {
  return { finishedAt, picks: picks.map(([id, reason]) => ({ id, reason })) }
}

const ids = (entries: ReturnType<typeof buildShortlist>) => entries.map(e => e.item.id)

describe('buildShortlist', () => {
  it('orders pins newest first, then picks in rank order, then fallback', () => {
    const items = [
      item(1, { pinnedAt: '2026-11-09T10:00:00Z' }),
      item(2, { pinnedAt: '2026-11-09T11:00:00Z' }),
      item(3), item(4), item(5), item(6),
    ]
    const entries = buildShortlist(items, curation([[4, 'New episode'], [3, null]]), NOW)
    expect(ids(entries).slice(0, 4)).toEqual([2, 1, 4, 3])
    expect(entries.map(e => e.tier)).toEqual(['pinned', 'pinned', 'pick', 'pick', 'fallback', 'fallback'])
    expect(entries[2].reason).toBe('New episode')
    expect(entries[3].reason).toBeNull()
    expect(entries[0].reason).toBeNull()
    expect(entries[4].reason).toBeNull()
  })

  it('shows a picked item that is also pinned once, as a pin', () => {
    const items = [item(1, { pinnedAt: iso(NOW) }), item(2)]
    const entries = buildShortlist(items, curation([[1, 'Because'], [2, 'Also']]), NOW)
    expect(ids(entries)).toEqual([1, 2])
    expect(entries[0]).toMatchObject({ tier: 'pinned', reason: null })
  })

  it('skips pick ids that are not in items', () => {
    const entries = buildShortlist([item(1), item(2)], curation([[99, 'Gone'], [2, 'Here']]), NOW)
    expect(entries[0]).toMatchObject({ tier: 'pick', reason: 'Here' })
    expect(ids(entries)).toEqual([2, 1])
  })

  it('ignores archived items even if the server sent them', () => {
    const entries = buildShortlist([item(1, { status: 'Completed' }), item(2)], curation([[1, 'x']]), NOW)
    expect(ids(entries)).toEqual([2])
  })

  it('excludes items dismissed within 21 days from picks and fallback', () => {
    const dismissed = iso(NOW - 5 * DAY)
    const items = [item(1, { shortlistDismissedAt: dismissed }), item(2, { shortlistDismissedAt: dismissed }), item(3)]
    const entries = buildShortlist(items, curation([[1, 'x']]), NOW)
    expect(ids(entries)).toEqual([3])
  })

  it('lets an item dismissed 22 days ago back in', () => {
    const items = [item(1, { shortlistDismissedAt: iso(NOW - 22 * DAY) })]
    expect(ids(buildShortlist(items, curation([[1, 'Back']]), NOW))).toEqual([1])
  })

  it('fills from recommendedSort without the intent signal when picks run out', () => {
    const same = { createdAt: iso(NOW - DAY), author: 'Same author A' }
    const positioned = item(1, { ...same, author: 'A', queuePosition: 1, positionConfirmed: true })
    const plain = item(2, { ...same, author: 'B' })
    // Identical except the legacy position: the tie breaks on lower id only
    // when position is ignored, so pass them in reverse to prove it.
    const entries = buildShortlist([plain, positioned], null, NOW)
    expect(entries.map(e => e.tier)).toEqual(['fallback', 'fallback'])
    expect(ids(entries)).toEqual([1, 2])
    const flipped = buildShortlist([item(1, { ...same, author: 'A' }), item(2, { ...same, author: 'B', queuePosition: 1, positionConfirmed: true })], null, NOW)
    expect(ids(flipped)).toEqual([1, 2])
  })

  it('with no curation shows pins then fallback', () => {
    const entries = buildShortlist([item(1), item(2, { pinnedAt: iso(NOW) })], null, NOW)
    expect(entries.map(e => [e.item.id, e.tier])).toEqual([[2, 'pinned'], [1, 'fallback']])
  })

  it('returns at most HOME_SIZE entries', () => {
    const items = Array.from({ length: 30 }, (_, i) => item(i + 1))
    const picks = curation(items.slice(0, 25).map(i => [i.id, null] as [number, null]))
    expect(buildShortlist(items, picks, NOW)).toHaveLength(HOME_SIZE)
    expect(HOME_SIZE).toBe(8)
  })

  it('shows every item once when there are fewer items than slots', () => {
    const items = [item(1), item(2, { pinnedAt: iso(NOW) }), item(3)]
    const entries = buildShortlist(items, curation([[3, null], [3, null], [2, null]]), NOW)
    expect(ids(entries).sort()).toEqual([1, 2, 3])
  })

  it('honours a custom size', () => {
    expect(buildShortlist([item(1), item(2), item(3)], null, NOW, 2)).toHaveLength(2)
  })
})

describe('isDismissedWithinHold', () => {
  it('uses a 21-day hold', () => {
    expect(DISMISS_HOLD_DAYS).toBe(21)
    expect(isDismissedWithinHold(null, NOW)).toBe(false)
    expect(isDismissedWithinHold(iso(NOW - 20 * DAY), NOW)).toBe(true)
    expect(isDismissedWithinHold(iso(NOW - 21 * DAY - 1), NOW)).toBe(false)
  })

  it('treats a timestamp slightly in the future as within the hold', () => {
    expect(isDismissedWithinHold(iso(NOW + 5_000), NOW)).toBe(true)
  })

  it('treats an unparseable timestamp as not dismissed', () => {
    expect(isDismissedWithinHold('not a date', NOW)).toBe(false)
  })
})

describe('parseCurationPicks', () => {
  it('returns [] for anything that is not an array', () => {
    expect(parseCurationPicks(null)).toEqual([])
    expect(parseCurationPicks({ id: 1 })).toEqual([])
    expect(parseCurationPicks('[]')).toEqual([])
  })

  it('drops entries with bad or repeated ids', () => {
    const raw = [{ id: 1, reason: 'a' }, { id: 1.5 }, { id: -2 }, { id: '3' }, null, { id: 1, reason: 'dup' }, { id: 4 }]
    expect(parseCurationPicks(raw)).toEqual([{ id: 1, reason: 'a' }, { id: 4, reason: null }])
  })

  it('cleans reasons: trims, blanks empty, too long, multi-line or non-string', () => {
    const raw = [
      { id: 1, reason: '  New episode  ' },
      { id: 2, reason: '   ' },
      { id: 3, reason: 'x'.repeat(61) },
      { id: 4, reason: 'two\nlines' },
      { id: 5, reason: 42 },
      { id: 6, reason: 'x'.repeat(60) },
    ]
    expect(parseCurationPicks(raw)).toEqual([
      { id: 1, reason: 'New episode' },
      { id: 2, reason: null },
      { id: 3, reason: null },
      { id: 4, reason: null },
      { id: 5, reason: null },
      { id: 6, reason: 'x'.repeat(60) },
    ])
  })

  it('keeps at most 25 picks', () => {
    const raw = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, reason: null }))
    expect(parseCurationPicks(raw)).toHaveLength(25)
  })
})

describe('curationFreshness', () => {
  const at = (msAgo: number) => curation([], iso(NOW - msAgo))

  it('says when there are no picks yet', () => {
    expect(curationFreshness(null, NOW)).toEqual({ label: 'No picks from Claude yet', stale: true })
  })

  it('reads recent runs as fresh', () => {
    expect(curationFreshness(at(20_000), NOW)).toEqual({ label: 'Picks updated just now', stale: false })
    expect(curationFreshness(at(5 * 60_000), NOW)).toEqual({ label: 'Picks updated 5m ago', stale: false })
    expect(curationFreshness(at(2 * HOUR), NOW)).toEqual({ label: 'Picks updated 2h ago', stale: false })
  })

  it('reads runs older than 24 hours as stale', () => {
    expect(curationFreshness(at(24 * HOUR), NOW).stale).toBe(false)
    expect(curationFreshness(at(30 * HOUR), NOW)).toEqual({ label: 'Picks updated 30h ago', stale: true })
    expect(curationFreshness(at(3 * DAY), NOW)).toEqual({ label: 'Picks updated 3 days ago', stale: true })
  })

  it('treats a finish time slightly ahead of the clock as just now', () => {
    expect(curationFreshness(at(-10_000), NOW)).toEqual({ label: 'Picks updated just now', stale: false })
  })
})

describe('isNewSince (#377 NEW marker)', () => {
  it('is new when added after the last visit', () => {
    expect(isNewSince(item(1, { createdAt: '2026-11-09T12:00:01Z' }), '2026-11-09T12:00:00Z')).toBe(true)
    expect(isNewSince(item(1, { createdAt: '2026-11-09T11:59:59Z' }), '2026-11-09T12:00:00Z')).toBe(false)
  })

  it('marks nothing new before the first recorded visit', () => {
    expect(isNewSince(item(1), null)).toBe(false)
  })
})
