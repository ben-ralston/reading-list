import { describe, it, expect } from 'vitest'
import type { QueueItem, ContentSource } from './queue-client'
import { recommendedScore, recommendedSort, WEIGHTS } from './recommended-sort'

// Fixed clock for deterministic scoring; default items are created "now".
const NOW = Date.parse('2026-08-01T00:00:00Z')
const NOW_ISO = '2026-08-01T00:00:00Z'

function daysAgo(days: number): string {
  return new Date(NOW - days * 86_400_000).toISOString()
}

function makeSource(overrides: Partial<ContentSource> = {}): ContentSource {
  return {
    id: 1,
    platform: 'Spotify',
    link: 'https://example.com',
    messageId: null,
    isPrimary: true,
    createdAt: NOW_ISO,
    sourceLabel: null,
    ...overrides,
  }
}

function makeItem(overrides: Partial<QueueItem> & { id: number }): QueueItem {
  return {
    title: `Item ${overrides.id}`,
    author: `Author ${overrides.id}`,
    publishedOn: null,
    status: '',
    queuePosition: null,
    positionConfirmed: false,
    progress: null,
    addedBy: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    statusChangedAt: null,
    kind: 'feed',
    sentToReaderAt: null,
    imageUrl: null,
    wordCount: null,
    durationSeconds: null,
    sources: [],
    platform: '',
    link: '',
    ...overrides,
  }
}

function sortedIds(items: QueueItem[]): number[] {
  return recommendedSort(items, { now: NOW }).map(i => i.id)
}

describe('recommendedScore', () => {
  it('gives an in-progress item a higher score than an identical non-started item', () => {
    const started = makeItem({ id: 1, status: 'In Progress' })
    const notStarted = makeItem({ id: 1 })
    expect(recommendedScore(started, NOW)).toBeGreaterThan(recommendedScore(notStarted, NOW))
  })

  it('ranks deeper progress higher among in-progress items', () => {
    const deep = makeItem({ id: 1, status: 'In Progress', progress: '90' })
    const shallow = makeItem({ id: 1, status: 'In Progress', progress: '10' })
    expect(recommendedScore(deep, NOW)).toBeGreaterThan(recommendedScore(shallow, NOW))
  })

  it('halves the recency contribution every 14 days', () => {
    const fresh = recommendedScore(makeItem({ id: 1, publishedOn: NOW_ISO }), NOW)
    const aged14 = recommendedScore(makeItem({ id: 1, publishedOn: daysAgo(14) }), NOW)
    const aged28 = recommendedScore(makeItem({ id: 1, publishedOn: daysAgo(28) }), NOW)
    expect(fresh - aged14).toBeCloseTo(WEIGHTS.recency * 0.5, 5)
    expect(aged14 - aged28).toBeCloseTo(WEIGHTS.recency * 0.25, 5)
  })

  it('clamps future publish dates to full recency', () => {
    const future = makeItem({ id: 1, publishedOn: daysAgo(-7) })
    const fresh = makeItem({ id: 1, publishedOn: NOW_ISO })
    expect(recommendedScore(future, NOW)).toBeCloseTo(recommendedScore(fresh, NOW), 5)
  })

  it('treats an unparseable date as zero recency, without throwing', () => {
    const junk = makeItem({ id: 1, createdAt: 'not-a-date' })
    const ancient = makeItem({ id: 1, publishedOn: daysAgo(10000) })
    expect(recommendedScore(junk, NOW)).toBeCloseTo(recommendedScore(ancient, NOW), 3)
  })

  it('orders engagement 0.8 > missing (neutral) > -0.8, all else equal', () => {
    const liked = recommendedScore(makeItem({ id: 1, engagementScore: 0.8 }), NOW)
    const neutral = recommendedScore(makeItem({ id: 1 }), NOW)
    const disliked = recommendedScore(makeItem({ id: 1, engagementScore: -0.8 }), NOW)
    expect(liked).toBeGreaterThan(neutral)
    expect(neutral).toBeGreaterThan(disliked)
  })

  it('scores confirmed low positions above unconfirmed, above unpositioned', () => {
    const confirmed = recommendedScore(makeItem({ id: 1, queuePosition: 1, positionConfirmed: true }), NOW)
    const suggested = recommendedScore(makeItem({ id: 1, queuePosition: 1, positionConfirmed: false }), NOW)
    const unpositioned = recommendedScore(makeItem({ id: 1 }), NOW)
    expect(confirmed).toBeGreaterThan(suggested)
    expect(suggested).toBeGreaterThan(unpositioned)
  })

  it('boosts items sent to the reader', () => {
    const sent = makeItem({ id: 1, sentToReaderAt: NOW_ISO })
    const unsent = makeItem({ id: 1 })
    expect(recommendedScore(sent, NOW)).toBeGreaterThan(recommendedScore(unsent, NOW))
  })

  it('keeps in-progress dominant over a maxed-out non-started item', () => {
    const staleStarted = makeItem({
      id: 1, status: 'In Progress', progress: '5', publishedOn: daysAgo(30),
    })
    const hotFresh = makeItem({
      id: 2, publishedOn: NOW_ISO, engagementScore: 1,
      queuePosition: 1, positionConfirmed: true, sentToReaderAt: NOW_ISO,
    })
    // A hot confirmed fresh item can edge out a stale barely-started one (intended),
    // but a moderately fresh in-progress item always leads a plain fresh item.
    const freshStarted = makeItem({ id: 3, status: 'In Progress', publishedOn: daysAgo(7) })
    const plainFresh = makeItem({ id: 4, publishedOn: NOW_ISO })
    expect(recommendedScore(freshStarted, NOW)).toBeGreaterThan(recommendedScore(plainFresh, NOW))
    expect(recommendedScore(hotFresh, NOW)).toBeGreaterThan(recommendedScore(staleStarted, NOW))
  })
})

describe('recommendedSort', () => {
  it('returns [] for empty input', () => {
    expect(recommendedSort([], { now: NOW })).toEqual([])
  })

  it('does not mutate the input array', () => {
    const items = [
      makeItem({ id: 1, publishedOn: daysAgo(20) }),
      makeItem({ id: 2, status: 'In Progress' }),
    ]
    const snapshot = [...items]
    recommendedSort(items, { now: NOW })
    expect(items).toEqual(snapshot)
    expect(items.map(i => i.id)).toEqual([1, 2])
  })

  it('floats in-progress items to the top', () => {
    const items = [
      makeItem({ id: 1, publishedOn: NOW_ISO }),
      makeItem({ id: 2, status: 'In Progress', publishedOn: daysAgo(10) }),
      makeItem({ id: 3, publishedOn: daysAgo(2) }),
    ]
    expect(sortedIds(items)[0]).toBe(2)
  })

  it('handles items with every optional signal missing', () => {
    const bare = makeItem({ id: 1, createdAt: '', updatedAt: '' })
    const normal = makeItem({ id: 2 })
    expect(sortedIds([bare, normal])).toEqual([2, 1])
  })

  it('spreads a same-author cluster: second pick of an author is halved', () => {
    // Three fresh same-author items vs one slightly older different author.
    const x1 = makeItem({ id: 1, author: 'Prolific', publishedOn: NOW_ISO })
    const x2 = makeItem({ id: 2, author: 'Prolific', publishedOn: daysAgo(1) })
    const x3 = makeItem({ id: 3, author: 'Prolific', publishedOn: daysAgo(2) })
    const y = makeItem({ id: 4, author: 'Occasional', publishedOn: daysAgo(3) })
    expect(sortedIds([x1, x2, x3, y])).toEqual([1, 4, 2, 3])
  })

  it('dampens repeat picks multiplicatively (0.25 on the third same-author item)', () => {
    // Author P: three items. Author Q: one item weak enough to lose to P's
    // second pick (halved) but strong enough to beat P's third (quartered).
    const p1 = makeItem({ id: 1, author: 'P', status: 'In Progress', publishedOn: NOW_ISO })
    const p2 = makeItem({ id: 2, author: 'P', status: 'In Progress', publishedOn: NOW_ISO })
    const p3 = makeItem({ id: 3, author: 'P', status: 'In Progress', publishedOn: NOW_ISO })
    // Base ≈ 0.635 for each P item; halved ≈ 0.3175, quartered ≈ 0.1587.
    const q = makeItem({ id: 4, author: 'Q', publishedOn: daysAgo(5) })
    // q base ≈ 0.2*0.78 + 0.075 ≈ 0.23: below P's halved score, above P's
    // quartered score → q lands in slot 3, P's third item drops to slot 4.
    expect(sortedIds([p1, p2, p3, q])).toEqual([1, 2, 4, 3])
  })

  it('groups unknown-author items by their primary source label', () => {
    const u1 = makeItem({
      id: 1, author: 'Unknown', publishedOn: NOW_ISO,
      sources: [makeSource({ id: 11, sourceLabel: 'Same Show' })],
    })
    const u2 = makeItem({
      id: 2, author: 'Unknown', publishedOn: daysAgo(1),
      sources: [makeSource({ id: 12, sourceLabel: 'Same Show' })],
    })
    const v = makeItem({ id: 3, author: 'Someone', publishedOn: daysAgo(3) })
    // u2 shares u1's key via the show label, so v leapfrogs it.
    expect(sortedIds([u1, u2, v])).toEqual([1, 3, 2])
  })

  it('does not dampen unknown-author items that lack a source label', () => {
    const w1 = makeItem({ id: 1, author: 'Unknown', publishedOn: NOW_ISO })
    const w2 = makeItem({ id: 2, author: 'Unknown', publishedOn: daysAgo(1) })
    const v = makeItem({ id: 3, author: 'Someone', publishedOn: daysAgo(3) })
    // Unique fallback keys: no dampening, so both stay ahead of v.
    expect(sortedIds([w1, w2, v])).toEqual([1, 2, 3])
  })

  it('is deterministic for identical input and clock', () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      makeItem({
        id: i + 1,
        author: `Author ${i % 5}`,
        publishedOn: daysAgo(i),
        status: i % 4 === 0 ? 'In Progress' : '',
      }),
    )
    expect(sortedIds(items)).toEqual(sortedIds(items))
  })

  it('breaks exact ties by newer date, then lower id', () => {
    const older = makeItem({ id: 1, publishedOn: daysAgo(5) })
    const newer = makeItem({ id: 2, publishedOn: daysAgo(4) })
    expect(sortedIds([older, newer])).toEqual([2, 1])

    const a = makeItem({ id: 7, publishedOn: daysAgo(5) })
    const b = makeItem({ id: 3, publishedOn: daysAgo(5) })
    expect(sortedIds([a, b])).toEqual([3, 7])
  })

  it('retains duplicate queuePosition-1 rows (#229)', () => {
    const dup1 = makeItem({ id: 1, queuePosition: 1, positionConfirmed: true })
    const dup2 = makeItem({ id: 2, queuePosition: 1, positionConfirmed: true })
    const other = makeItem({ id: 3 })
    const order = sortedIds([dup1, dup2, other])
    expect(order).toHaveLength(3)
    expect(new Set(order)).toEqual(new Set([1, 2, 3]))
  })

  it('handles 1000 items and returns each exactly once', () => {
    const items = Array.from({ length: 1000 }, (_, i) =>
      makeItem({
        id: i + 1,
        author: `Author ${i % 50}`,
        publishedOn: daysAgo(i % 90),
        status: i % 10 === 0 ? 'In Progress' : '',
        progress: i % 10 === 0 ? String(i % 100) : null,
      }),
    )
    const order = sortedIds(items)
    expect(order).toHaveLength(1000)
    expect(new Set(order).size).toBe(1000)
  })
})

it('scores Awaiting comments like In Progress at the same actual progress', () => {
  const pending = makeItem({ id: 1, status: 'Awaiting comments', progress: '96' })
  expect(recommendedScore(pending, NOW)).toBe(recommendedScore({ ...pending, status: 'In Progress' }, NOW))
})

describe('recommendedSort intent option (#377)', () => {
  it('intent: false ignores queue positions', () => {
    const positioned = makeItem({ id: 2, queuePosition: 1, positionConfirmed: true })
    const plain = makeItem({ id: 1 })
    expect(recommendedSort([positioned, plain], { now: NOW }).map(i => i.id)).toEqual([2, 1])
    expect(recommendedSort([positioned, plain], { now: NOW, intent: false }).map(i => i.id)).toEqual([1, 2])
    expect(recommendedScore(positioned, NOW, { intent: false })).toBe(recommendedScore(plain, NOW, { intent: false }))
  })
})
