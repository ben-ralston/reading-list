import { describe, it, expect } from 'vitest'
import type { QueueItem } from '@/lib/queue-client'
import { attachEngagementScores, type EngagementRow } from './engagement'

function makeItem(overrides: Partial<QueueItem> & { id: number; author: string }): QueueItem {
  return {
    title: `Item ${overrides.id}`,
    publishedOn: null,
    status: '',
    queuePosition: null,
    positionConfirmed: false,
    progress: null,
    addedBy: null,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
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

function makeRow(overrides: Partial<EngagementRow> = {}): EngagementRow {
  return {
    canonical_author: 'jane doe',
    aliases: ['jane doe'],
    engagement_score: 0.6,
    ...overrides,
  }
}

describe('attachEngagementScores', () => {
  it('matches items by canonical author', () => {
    const items = [makeItem({ id: 1, author: 'jane doe' })]
    const result = attachEngagementScores(items, [makeRow()])
    expect(result[0].engagementScore).toBe(0.6)
  })

  it('matches items by alias', () => {
    const rows = [makeRow({ canonical_author: 'jane doe', aliases: ['jane doe', 'j. doe'] })]
    const items = [makeItem({ id: 1, author: 'J. Doe' })]
    const result = attachEngagementScores(items, rows)
    expect(result[0].engagementScore).toBe(0.6)
  })

  it('normalizes casing and whitespace when matching', () => {
    const items = [makeItem({ id: 1, author: '  JANE DOE  ' })]
    const result = attachEngagementScores(items, [makeRow()])
    expect(result[0].engagementScore).toBe(0.6)
  })

  it('sets null for authors with no engagement row', () => {
    const items = [makeItem({ id: 1, author: 'Stranger' })]
    const result = attachEngagementScores(items, [makeRow()])
    expect(result[0].engagementScore).toBeNull()
  })

  it('sets null for every item when there are no rows', () => {
    const items = [
      makeItem({ id: 1, author: 'jane doe' }),
      makeItem({ id: 2, author: 'Someone' }),
    ]
    const result = attachEngagementScores(items, [])
    expect(result.map(i => i.engagementScore)).toEqual([null, null])
  })

  it('coerces string-serialized numeric scores (PostgREST)', () => {
    const rows = [makeRow({ engagement_score: '0.75' as unknown as number })]
    const items = [makeItem({ id: 1, author: 'jane doe' })]
    const result = attachEngagementScores(items, rows)
    expect(result[0].engagementScore).toBe(0.75)
  })

  it('never assigns the Unknown-bucket aggregate to unknown-author items', () => {
    // A literal "Unknown" author aggregated in the view must not leak onto
    // items whose author normalizes to the Unknown bucket ('').
    const rows = [makeRow({ canonical_author: 'Unknown', aliases: ['unknown', ''] })]
    const items = [
      makeItem({ id: 1, author: 'Unknown' }),
      makeItem({ id: 2, author: '   ' }),
    ]
    const result = attachEngagementScores(items, rows)
    expect(result.map(i => i.engagementScore)).toEqual([null, null])
  })

  it('returns new item objects, leaving the input untouched', () => {
    const item = makeItem({ id: 1, author: 'jane doe' })
    const result = attachEngagementScores([item], [makeRow()])
    expect(item.engagementScore).toBeUndefined()
    expect(result[0]).not.toBe(item)
  })
})
