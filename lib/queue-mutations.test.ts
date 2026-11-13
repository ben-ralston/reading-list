import { describe, it, expect } from 'vitest'
import type { QueueItem } from '@/lib/queue-client'
import {
  applyComplete,
  applyToggleStarted,
  applyStartItem,
  applyMakeNext,
  applyReorder,
  applyAwcQueued,
  applyAwcRequestResult,
  applyPin,
  applyDismiss,
} from './queue-mutations'

// Helper to create a mock QueueItem with sensible defaults
function makeItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 1,
    title: 'Test Item',
    author: 'Author',
    publishedOn: null,
    status: '',
    queuePosition: null,
    positionConfirmed: false,
    progress: null,
    addedBy: null,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    statusChangedAt: null,
    sources: [{ id: 1, platform: 'Web', link: 'https://example.com', messageId: null, isPrimary: true, createdAt: '2025-01-01T00:00:00Z', sourceLabel: null }],
    platform: 'Web',
    link: 'https://example.com',
    ...overrides,
  }
}

describe('applyComplete', () => {
  it('removes the item from the queue', () => {
    const queue = [makeItem({ id: 1 }), makeItem({ id: 2 }), makeItem({ id: 3 })]
    const result = applyComplete(queue, 2)
    expect(result).toHaveLength(2)
    expect(result.map(i => i.id)).toEqual([1, 3])
  })

  it('returns unchanged queue if item not found', () => {
    const queue = [makeItem({ id: 1 })]
    const result = applyComplete(queue, 999)
    expect(result).toEqual(queue)
  })
})

describe('applyToggleStarted', () => {
  it('sets status to "In Progress" when currently empty', () => {
    const queue = [makeItem({ id: 1, status: '' })]
    const result = applyToggleStarted(queue, 1, '')
    expect(result[0].status).toBe('In Progress')
  })

  it('clears status when currently "In Progress"', () => {
    const queue = [makeItem({ id: 1, status: 'In Progress' })]
    const result = applyToggleStarted(queue, 1, 'In Progress')
    expect(result[0].status).toBe('')
  })

  it('does not affect other items', () => {
    const queue = [makeItem({ id: 1, status: '' }), makeItem({ id: 2, status: 'In Progress' })]
    const result = applyToggleStarted(queue, 1, '')
    expect(result[1].status).toBe('In Progress')
  })
})

describe('applyStartItem', () => {
  it('sets status to "In Progress"', () => {
    const queue = [makeItem({ id: 1, status: '' })]
    const result = applyStartItem(queue, 1)
    expect(result[0].status).toBe('In Progress')
  })

  it('is idempotent when already "In Progress"', () => {
    const queue = [makeItem({ id: 1, status: 'In Progress' })]
    const result = applyStartItem(queue, 1)
    expect(result[0].status).toBe('In Progress')
  })
})

describe('applyMakeNext', () => {
  it('moves target to position 1 and renumbers others sequentially', () => {
    const queue = [
      makeItem({ id: 1, queuePosition: 1, positionConfirmed: true }),
      makeItem({ id: 2, queuePosition: 2, positionConfirmed: true }),
      makeItem({ id: 3, queuePosition: 3, positionConfirmed: true }),
    ]
    const result = applyMakeNext(queue, 3)
    expect(result[0].id).toBe(3)
    expect(result[0].queuePosition).toBe(1)
    expect(result[0].positionConfirmed).toBe(true)
    expect(result[1].id).toBe(1)
    expect(result[1].queuePosition).toBe(2)
    expect(result[2].id).toBe(2)
    expect(result[2].queuePosition).toBe(3)
  })

  it('correctly handles mixed positioned and unpositioned items (Bug 1 regression)', () => {
    // This was the critical bug: null-position items incremented the index
    // causing positioned items after them to get wrong position numbers
    const queue = [
      makeItem({ id: 1, queuePosition: 1 }),
      makeItem({ id: 2, queuePosition: 2 }),
      makeItem({ id: 3, queuePosition: null }), // unpositioned
      makeItem({ id: 4, queuePosition: 3 }),
    ]
    const result = applyMakeNext(queue, 4)

    // Target should be at position 1
    expect(result[0].id).toBe(4)
    expect(result[0].queuePosition).toBe(1)

    // Other positioned items renumbered from 2
    const positioned = result.filter(i => i.queuePosition !== null && i.id !== 4)
    expect(positioned).toHaveLength(2)
    expect(positioned[0].id).toBe(1)
    expect(positioned[0].queuePosition).toBe(2)
    expect(positioned[1].id).toBe(2)
    expect(positioned[1].queuePosition).toBe(3)

    // Unpositioned item still has null position
    const unpositioned = result.filter(i => i.queuePosition === null)
    expect(unpositioned).toHaveLength(1)
    expect(unpositioned[0].id).toBe(3)
  })

  it('handles target with no queue position', () => {
    const queue = [
      makeItem({ id: 1, queuePosition: 1 }),
      makeItem({ id: 2, queuePosition: null }),
    ]
    const result = applyMakeNext(queue, 2)
    expect(result[0].id).toBe(2)
    expect(result[0].queuePosition).toBe(1)
    expect(result[0].positionConfirmed).toBe(true)
    expect(result[1].id).toBe(1)
    expect(result[1].queuePosition).toBe(2)
  })

  it('returns unchanged queue if target not found', () => {
    const queue = [makeItem({ id: 1, queuePosition: 1 })]
    const result = applyMakeNext(queue, 999)
    expect(result).toEqual(queue)
  })
})

describe('applyReorder', () => {
  it('assigns sequential queuePosition values starting from 2 (Bug 2 regression)', () => {
    const queue = [
      makeItem({ id: 1, queuePosition: 1 }), // current item
      makeItem({ id: 2, queuePosition: 2 }),
      makeItem({ id: 3, queuePosition: 3 }),
      makeItem({ id: 4, queuePosition: null }), // unpositioned
    ]
    // Reorder: swap items 2 and 3 (item 3 was moved)
    const reorderedItems = [
      makeItem({ id: 3, queuePosition: 3 }),
      makeItem({ id: 2, queuePosition: 2 }),
    ]
    const result = applyReorder(queue, reorderedItems, 3)

    // Current item stays first
    expect(result[0].id).toBe(1)

    // Reordered items get sequential positions from 2
    expect(result[1].id).toBe(3)
    expect(result[1].queuePosition).toBe(2)
    expect(result[2].id).toBe(2)
    expect(result[2].queuePosition).toBe(3)

    // Unpositioned items come last
    expect(result[3].id).toBe(4)
    expect(result[3].queuePosition).toBe(null)
  })

  it('sets positionConfirmed to true only on the moved item', () => {
    const queue = [
      makeItem({ id: 1, queuePosition: 1 }),
      makeItem({ id: 2, queuePosition: 2, positionConfirmed: false }),
      makeItem({ id: 3, queuePosition: 3, positionConfirmed: false }),
    ]
    const reorderedItems = [
      makeItem({ id: 3, positionConfirmed: false }),
      makeItem({ id: 2, positionConfirmed: false }),
    ]
    // Item 3 was the one dragged
    const result = applyReorder(queue, reorderedItems, 3)
    expect(result[1].positionConfirmed).toBe(true)   // moved item: confirmed
    expect(result[2].positionConfirmed).toBe(false)   // untouched item: stays unconfirmed
  })

  it('does not duplicate an unpositioned item that is also in reorderedItems (#147 books, Bug B)', () => {
    // Books drag their unpositioned entries too, so an item can be both in
    // reorderedItems and match the "no position" tail filter. It must not
    // appear twice — duplicate ids poison the next batch-update payload.
    const queue = [
      makeItem({ id: 1, queuePosition: 1 }),    // current
      makeItem({ id: 2, queuePosition: null }), // unpositioned, dragged
      makeItem({ id: 3, queuePosition: null }), // unpositioned, dragged
    ]
    const reorderedItems = [
      makeItem({ id: 3, queuePosition: null }),
      makeItem({ id: 2, queuePosition: null }),
    ]
    const result = applyReorder(queue, reorderedItems, 3)

    const ids = result.map(i => i.id)
    expect(new Set(ids).size).toBe(ids.length) // no duplicates
    expect([...ids].sort()).toEqual([1, 2, 3])
    expect(result.find(i => i.id === 3)?.queuePosition).toBe(2)
    expect(result.find(i => i.id === 2)?.queuePosition).toBe(3)
  })

  it('handles empty queue gracefully', () => {
    const reorderedItems = [makeItem({ id: 2, queuePosition: 5 })]
    const result = applyReorder([], reorderedItems, 2)
    // Empty queue guard returns reorderedItems as-is (no renumbering)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe(2)
    expect(result[0].queuePosition).toBe(5)
  })

  // RLV-007 (#203): after completing the old hero, the new hero sits at
  // position 2. A drag then writes 2..N over the draggable rows and two rows
  // hold position 2. The hero must be pinned to 1 — but a reorder of OTHER
  // rows must not silently confirm an AI-suggested hero.
  it('pins the hero to position 1, preserving its positionConfirmed (#203)', () => {
    const queue = [
      makeItem({ id: 1, queuePosition: 2, positionConfirmed: false }), // new hero, AI-suggested
      makeItem({ id: 2, queuePosition: 3 }),
      makeItem({ id: 3, queuePosition: 4 }),
    ]
    const reorderedItems = [
      makeItem({ id: 3, queuePosition: 4 }),
      makeItem({ id: 2, queuePosition: 3 }),
    ]
    const result = applyReorder(queue, reorderedItems, 3)

    expect(result[0].id).toBe(1)
    expect(result[0].queuePosition).toBe(1)
    expect(result[0].positionConfirmed).toBe(false)
    // No duplicate positions anywhere.
    const positions = result.map(i => i.queuePosition)
    expect(new Set(positions).size).toBe(positions.length)
  })
})

describe('Awaiting comments optimistic actions', () => {
  it('preserves pending comments when starting a source', () => {
    const queue = [makeItem({ status: 'Awaiting comments' })]
    expect(applyStartItem(queue, 1)).toEqual(queue)
  })
  it('ignores a stale started toggle on a pending item', () => {
    const queue = [makeItem({ status: 'Awaiting comments' })]
    expect(applyToggleStarted(queue, 1, '')).toEqual(queue)
  })
})

describe('applyAwcQueued (#317)', () => {
  it('stamps a queued conversion on the target item only', () => {
    const q = [makeItem({ id: 1 }), makeItem({ id: 2 })]
    const out = applyAwcQueued(q, 2, '2026-10-04T12:00:00Z')
    expect(out[0]).toBe(q[0])
    expect(out[1].awcConversion).toMatchObject({ status: 'queued', requestedAt: '2026-10-04T12:00:00Z' })
  })
})

describe('applyAwcRequestResult (#317 review)', () => {
  const conv = { id: 12, status: 'queued' as const, error: null, requestedAt: 'r', updatedAt: 'u' }
  it('replaces the optimistic placeholder with the server row', () => {
    const q = applyAwcQueued([makeItem({ id: 1 })], 1, 'now')
    expect(applyAwcRequestResult(q, 1, conv)[0].awcConversion).toEqual(conv)
  })
  it('leaves a card the poll already advanced alone', () => {
    const advanced = [makeItem({ id: 1, awcConversion: { ...conv, id: 12, status: 'starting' } })]
    expect(applyAwcRequestResult(advanced, 1, conv)[0].awcConversion?.status).toBe('starting')
  })
})

describe('applyPin / applyDismiss (#377)', () => {
  const NOW = '2026-11-09T12:00:00.000Z'

  it('applyPin sets pinnedAt and clears a dismissal, leaving others alone', () => {
    const queue = [makeItem({ id: 1, shortlistDismissedAt: '2026-11-01T00:00:00Z' }), makeItem({ id: 2 })]
    const next = applyPin(queue, 1, NOW)
    expect(next[0]).toMatchObject({ id: 1, pinnedAt: NOW, shortlistDismissedAt: null })
    expect(next[1]).toBe(queue[1])
    expect(queue[0].pinnedAt).toBeUndefined()
  })

  it('applyDismiss clears the pin and stamps the dismissal', () => {
    const queue = [makeItem({ id: 1, pinnedAt: '2026-11-08T00:00:00Z' })]
    expect(applyDismiss(queue, 1, NOW)[0]).toMatchObject({ pinnedAt: null, shortlistDismissedAt: NOW })
  })
})
