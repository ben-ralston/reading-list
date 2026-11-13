import { describe, it, expect } from 'vitest'
import type { QueueItem } from './queue-client'
import {
  READ_STATES_BY_KIND,
  buildReadStateOptions,
  matchesReadStateFilter,
  readStateOf,
} from './read-state'

// Minimal item factory; `status`, `positionConfirmed` are the only fields the
// read-state logic reads.
function makeItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 1,
    title: 'Test Item',
    author: 'Test Author',
    publishedOn: null,
    status: '',
    queuePosition: 1,
    positionConfirmed: true,
    progress: null,
    addedBy: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    statusChangedAt: null,
    kind: 'feed',
    sentToReaderAt: null,
    imageUrl: null,
    wordCount: null,
    durationSeconds: null,
    sources: [
      { id: 1, platform: 'Substack', link: 'https://example.com/a', messageId: null, isPrimary: true, createdAt: '2026-01-01T00:00:00Z', sourceLabel: null },
    ],
    platform: 'Substack',
    link: 'https://example.com/a',
    ...overrides,
  }
}

describe('readStateOf', () => {
  it('maps feed items to in-progress / confirmed / suggested', () => {
    expect(readStateOf(makeItem({ status: 'In Progress' }), 'feed')).toBe('in-progress')
    expect(readStateOf(makeItem({ status: '', positionConfirmed: true }), 'feed')).toBe('confirmed')
    expect(readStateOf(makeItem({ status: '', positionConfirmed: false }), 'feed')).toBe('suggested')
  })

  it('classifies an in-progress item with an unconfirmed position as in-progress, not suggested', () => {
    expect(readStateOf(makeItem({ status: 'In Progress', positionConfirmed: false }), 'feed')).toBe('in-progress')
  })

  it('maps book items to in-progress / not-started, ignoring positionConfirmed', () => {
    expect(readStateOf(makeItem({ status: 'In Progress' }), 'book')).toBe('in-progress')
    expect(readStateOf(makeItem({ status: '', positionConfirmed: true }), 'book')).toBe('not-started')
    expect(readStateOf(makeItem({ status: '', positionConfirmed: false }), 'book')).toBe('not-started')
  })
})

describe('buildReadStateOptions', () => {
  it('returns the full fixed feed list in order with counts', () => {
    const items = [
      makeItem({ id: 1, status: 'In Progress' }),
      makeItem({ id: 2, status: '', positionConfirmed: true }),
      makeItem({ id: 3, status: '', positionConfirmed: true }),
      makeItem({ id: 4, status: '', positionConfirmed: false }),
    ]
    expect(buildReadStateOptions(items, 'feed')).toEqual([
      { key: 'in-progress', label: 'In progress', count: 1 },
      { key: 'awaiting-comments', label: 'Awaiting comments', count: 0 },
      { key: 'confirmed', label: 'Confirmed', count: 2 },
      { key: 'suggested', label: 'Suggested', count: 1 },
    ])
  })

  it('keeps zero-count states listed', () => {
    const items = [makeItem({ id: 1, status: 'In Progress' })]
    expect(buildReadStateOptions(items, 'feed')).toEqual([
      { key: 'in-progress', label: 'In progress', count: 1 },
      { key: 'awaiting-comments', label: 'Awaiting comments', count: 0 },
      { key: 'confirmed', label: 'Confirmed', count: 0 },
      { key: 'suggested', label: 'Suggested', count: 0 },
    ])
  })

  it('returns all-zero options for an empty scope', () => {
    expect(buildReadStateOptions([], 'book')).toEqual([
      { key: 'in-progress', label: 'In progress', count: 0 },
      { key: 'not-started', label: 'Not started', count: 0 },
    ])
  })

  it('returns exactly the two book states for kind book', () => {
    const items = [
      makeItem({ id: 1, kind: 'book', status: 'In Progress' }),
      makeItem({ id: 2, kind: 'book', status: '', positionConfirmed: false }),
    ]
    expect(buildReadStateOptions(items, 'book')).toEqual([
      { key: 'in-progress', label: 'In progress', count: 1 },
      { key: 'not-started', label: 'Not started', count: 1 },
    ])
    expect(READ_STATES_BY_KIND.book).toEqual(['in-progress', 'not-started'])
  })
})

describe('matchesReadStateFilter', () => {
  const inProgress = makeItem({ id: 1, status: 'In Progress' })
  const confirmed = makeItem({ id: 2, status: '', positionConfirmed: true })
  const suggested = makeItem({ id: 3, status: '', positionConfirmed: false })

  it('passes everything through when nothing is selected', () => {
    expect(matchesReadStateFilter(inProgress, 'feed', [])).toBe(true)
    expect(matchesReadStateFilter(confirmed, 'feed', [])).toBe(true)
  })

  it('matches a single selected state', () => {
    expect(matchesReadStateFilter(inProgress, 'feed', ['in-progress'])).toBe(true)
    expect(matchesReadStateFilter(confirmed, 'feed', ['in-progress'])).toBe(false)
  })

  it('ORs across multiple selected states', () => {
    const selected = ['in-progress', 'suggested'] as const
    expect(matchesReadStateFilter(inProgress, 'feed', [...selected])).toBe(true)
    expect(matchesReadStateFilter(suggested, 'feed', [...selected])).toBe(true)
    expect(matchesReadStateFilter(confirmed, 'feed', [...selected])).toBe(false)
  })
})

it('exposes Awaiting comments as its own feed status filter', () => {
  const item = makeItem({ status: 'Awaiting comments' })
  expect(readStateOf(item, 'feed')).toBe('awaiting-comments')
  expect(buildReadStateOptions([item], 'feed')).toContainEqual({ key: 'awaiting-comments', label: 'Awaiting comments', count: 1 })
  expect(matchesReadStateFilter(item, 'feed', ['awaiting-comments'])).toBe(true)
  expect(matchesReadStateFilter(item, 'feed', ['confirmed'])).toBe(false)
})
