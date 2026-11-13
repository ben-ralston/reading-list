import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { QueueItem } from './queue-client'
import { useQueueFilters } from './use-queue-filters'

// Minimal item factory; `author` and the source platform (audio vs text)
// are the only fields the filters read.
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

function makeAudioItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return makeItem({
    sources: [
      { id: 1, platform: 'Spotify', link: 'https://open.spotify.com/episode/x', messageId: null, isPrimary: true, createdAt: '2026-01-01T00:00:00Z', sourceLabel: null },
    ],
    platform: 'Spotify',
    link: 'https://open.spotify.com/episode/x',
    ...overrides,
  })
}

describe('useQueueFilters', () => {
  const items = () => [
    makeItem({ id: 1, author: 'Jane Doe' }),
    makeItem({ id: 2, author: 'John Smith' }),
    makeAudioItem({ id: 3, author: 'Jane Doe' }),
  ]

  it('defaults to no filters: everything visible, correct counts', () => {
    const { result } = renderHook(() => useQueueFilters(items()))

    expect(result.current.mediaFilter).toBe('all')
    expect(result.current.selectedAuthors).toEqual([])
    expect(result.current.filteredQueue.map(i => i.id)).toEqual([1, 2, 3])
    expect(result.current.mediaCounts).toEqual({ all: 3, audio: 1, text: 2 })
  })

  it('filters by media type; media counts stay whole-queue', () => {
    const { result } = renderHook(() => useQueueFilters(items()))

    act(() => result.current.setMediaFilter('audio'))
    expect(result.current.filteredQueue.map(i => i.id)).toEqual([3])
    // Pill counts are deliberately not narrowed by any filter.
    expect(result.current.mediaCounts).toEqual({ all: 3, audio: 1, text: 2 })
  })

  it('filters by selected authors', () => {
    const { result } = renderHook(() => useQueueFilters(items()))

    act(() => result.current.setSelectedAuthors(['Jane Doe']))
    expect(result.current.filteredQueue.map(i => i.id)).toEqual([1, 3])
  })

  it('AND-composes the media and author filters', () => {
    const { result } = renderHook(() => useQueueFilters(items()))

    act(() => {
      result.current.setMediaFilter('text')
      result.current.setSelectedAuthors(['Jane Doe'])
    })
    expect(result.current.filteredQueue.map(i => i.id)).toEqual([1])
  })

  it('scopes author options to the media filter, keeping selected authors with count 0', () => {
    const { result } = renderHook(() => useQueueFilters(items()))

    // All: Jane has 2 items, John 1.
    expect(result.current.authorOptions).toEqual([
      { key: 'jane doe', label: 'Jane Doe', count: 2 },
      { key: 'john smith', label: 'John Smith', count: 1 },
    ])

    // Audio scope: only Jane remains (her Spotify item).
    act(() => result.current.setMediaFilter('audio'))
    expect(result.current.authorOptions).toEqual([
      { key: 'jane doe', label: 'Jane Doe', count: 1 },
    ])

    // A selected author out of the audio scope stays listed with count 0.
    act(() => result.current.setSelectedAuthors(['John Smith']))
    expect(result.current.authorOptions).toEqual([
      { key: 'jane doe', label: 'Jane Doe', count: 1 },
      { key: 'john smith', label: 'John Smith', count: 0 },
    ])
  })

  it('returns an empty queue when the selection matches nothing', () => {
    const { result } = renderHook(() => useQueueFilters(items()))

    act(() => {
      result.current.setMediaFilter('audio')
      result.current.setSelectedAuthors(['John Smith'])
    })
    expect(result.current.filteredQueue).toEqual([])
  })
})

describe('useQueueFilters read-state filter (#227)', () => {
  // 1: in progress, 2: confirmed, 3: suggested, 4: confirmed audio.
  const items = () => [
    makeItem({ id: 1, status: 'In Progress' }),
    makeItem({ id: 2, status: '', positionConfirmed: true }),
    makeItem({ id: 3, status: '', positionConfirmed: false }),
    makeAudioItem({ id: 4, status: '', positionConfirmed: true }),
  ]

  it('defaults to no read-state filter with the full feed option list', () => {
    const { result } = renderHook(() => useQueueFilters(items()))

    expect(result.current.selectedReadStates).toEqual([])
    expect(result.current.filteredQueue.map(i => i.id)).toEqual([1, 2, 3, 4])
    expect(result.current.readStateOptions).toEqual([
      { key: 'in-progress', label: 'In progress', count: 1 },
      { key: 'awaiting-comments', label: 'Awaiting comments', count: 0 },
      { key: 'confirmed', label: 'Confirmed', count: 2 },
      { key: 'suggested', label: 'Suggested', count: 1 },
    ])
  })

  it('ORs across selected read-states', () => {
    const { result } = renderHook(() => useQueueFilters(items()))

    act(() => result.current.setSelectedReadStates(['in-progress', 'suggested']))
    expect(result.current.filteredQueue.map(i => i.id)).toEqual([1, 3])
  })

  it('AND-composes with the media filter', () => {
    const { result } = renderHook(() => useQueueFilters(items()))

    act(() => {
      result.current.setMediaFilter('audio')
      result.current.setSelectedReadStates(['confirmed'])
    })
    expect(result.current.filteredQueue.map(i => i.id)).toEqual([4])
  })

  it('AND-composes with the author filter', () => {
    const { result } = renderHook(() =>
      useQueueFilters([
        makeItem({ id: 1, status: 'In Progress', author: 'Jane Doe' }),
        makeItem({ id: 2, status: 'In Progress', author: 'John Smith' }),
        makeItem({ id: 3, status: '', author: 'Jane Doe' }),
      ]),
    )

    act(() => {
      result.current.setSelectedReadStates(['in-progress'])
      result.current.setSelectedAuthors(['Jane Doe'])
    })
    expect(result.current.filteredQueue.map(i => i.id)).toEqual([1])
  })

  it('scopes read-state counts to the media filter, keeping zero-count states listed', () => {
    const { result } = renderHook(() => useQueueFilters(items()))

    act(() => result.current.setMediaFilter('audio'))
    expect(result.current.readStateOptions).toEqual([
      { key: 'in-progress', label: 'In progress', count: 0 },
      { key: 'awaiting-comments', label: 'Awaiting comments', count: 0 },
      { key: 'confirmed', label: 'Confirmed', count: 1 },
      { key: 'suggested', label: 'Suggested', count: 0 },
    ])
  })

  it('does not narrow author options by the read-state filter', () => {
    const { result } = renderHook(() =>
      useQueueFilters([
        makeItem({ id: 1, status: 'In Progress', author: 'Jane Doe' }),
        makeItem({ id: 2, status: '', author: 'John Smith' }),
      ]),
    )

    act(() => result.current.setSelectedReadStates(['in-progress']))
    expect(result.current.authorOptions).toEqual([
      { key: 'jane doe', label: 'Jane Doe', count: 1 },
      { key: 'john smith', label: 'John Smith', count: 1 },
    ])
  })

  it('uses the book state set for kind book, bucketing unconfirmed pending books as not-started', () => {
    const { result } = renderHook(() =>
      useQueueFilters(
        [
          makeItem({ id: 1, kind: 'book', status: 'In Progress' }),
          makeItem({ id: 2, kind: 'book', status: '', positionConfirmed: false }),
        ],
        'book',
      ),
    )

    expect(result.current.readStateOptions).toEqual([
      { key: 'in-progress', label: 'In progress', count: 1 },
      { key: 'not-started', label: 'Not started', count: 1 },
    ])

    act(() => result.current.setSelectedReadStates(['not-started']))
    expect(result.current.filteredQueue.map(i => i.id)).toEqual([2])
  })
})

describe('useQueueFilters search (#283)', () => {
  const items = () => [
    makeItem({ id: 1, title: 'The Bitter Lesson', author: 'Rich Sutton' }),
    makeItem({ id: 2, title: 'Attention Is All You Need', author: 'Vaswani' }),
    makeAudioItem({ id: 3, title: 'Lesson Planning', author: 'Jane Doe' }),
  ]

  it('defaults to an empty query with everything visible', () => {
    const { result } = renderHook(() => useQueueFilters(items()))
    expect(result.current.searchQuery).toBe('')
    expect(result.current.filteredQueue.map(i => i.id)).toEqual([1, 2, 3])
  })

  it('filters by title or author substring, case-insensitively', () => {
    const { result } = renderHook(() => useQueueFilters(items()))
    act(() => result.current.setSearchQuery('LESSON'))
    expect(result.current.filteredQueue.map(i => i.id)).toEqual([1, 3])
    act(() => result.current.setSearchQuery('sutton'))
    expect(result.current.filteredQueue.map(i => i.id)).toEqual([1])
  })

  it('ANDs with the media filter', () => {
    const { result } = renderHook(() => useQueueFilters(items()))
    act(() => result.current.setSearchQuery('lesson'))
    act(() => result.current.setMediaFilter('audio'))
    expect(result.current.filteredQueue.map(i => i.id)).toEqual([3])
  })

  it('narrows the media counts and dropdown options to the search', () => {
    const { result } = renderHook(() => useQueueFilters(items()))
    act(() => result.current.setSearchQuery('lesson'))
    expect(result.current.mediaCounts).toEqual({ all: 2, audio: 1, text: 1 })
    expect(result.current.authorOptions.map(o => o.label)).toEqual(['Jane Doe', 'Rich Sutton'])
  })

  it('clearing the query restores the full list', () => {
    const { result } = renderHook(() => useQueueFilters(items()))
    act(() => result.current.setSearchQuery('sutton'))
    act(() => result.current.setSearchQuery(''))
    expect(result.current.filteredQueue.map(i => i.id)).toEqual([1, 2, 3])
  })
})
