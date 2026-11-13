import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { QueueItem } from './queue-client'

const api = vi.hoisted(() => ({
  updateItemStatus: vi.fn(),
  pinItem: vi.fn(),
  dismissItem: vi.fn(),
  fetchFeedHome: vi.fn(),
  markSentToReader: vi.fn(),
  requestAwcConversion: vi.fn(),
}))
vi.mock('./queue-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./queue-client')>()),
  ...api,
}))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }) }))
// Polling has its own tests; keep it inert here.
vi.mock('./awc/polling', () => ({ useAwcConversionPolling: () => ({ stale: false, checkedAt: 0 }) }))

import { useFeedQueue } from './use-feed-queue'

function item(id: number, over: Partial<QueueItem> = {}): QueueItem {
  return {
    id, title: `T${id}`, author: 'A', publishedOn: null, status: '', queuePosition: null,
    positionConfirmed: false, progress: null, addedBy: null, createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z', statusChangedAt: null, kind: 'feed', sentToReaderAt: null,
    imageUrl: null, wordCount: null, durationSeconds: null, sources: [], platform: '', link: '',
    pinnedAt: null, shortlistDismissedAt: null, ...over,
  }
}

const NOW = Date.parse('2026-11-09T12:00:00Z')

function setup(items = [item(1), item(2), item(3)]) {
  return renderHook(() => useFeedQueue({ items, curation: null, nowMs: NOW }))
}

function deferred() {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
})

describe('useFeedQueue', () => {
  it('starts from the initial items, curation and clock', () => {
    const { result } = setup()
    expect(result.current.items.map(i => i.id)).toEqual([1, 2, 3])
    expect(result.current.curation).toBeNull()
    expect(result.current.nowMs).toBe(NOW)
  })

  it('onMarkComplete removes the item', async () => {
    api.updateItemStatus.mockResolvedValue(undefined)
    const { result } = setup()
    await act(() => result.current.actions.onMarkComplete(result.current.items[0]))
    expect(result.current.items.map(i => i.id)).toEqual([2, 3])
    expect(api.updateItemStatus).toHaveBeenCalledWith(1, 'Completed')
  })

  it('onNotNow sets shortlistDismissedAt optimistically and rolls back on 409', async () => {
    const d = deferred()
    api.dismissItem.mockReturnValue(d.promise)
    const { result } = setup([item(1, { pinnedAt: '2026-11-08T00:00:00Z' })])
    let pending!: Promise<void>
    act(() => { pending = result.current.actions.onNotNow(result.current.items[0]) })
    expect(result.current.items[0].shortlistDismissedAt).toEqual(expect.any(String))
    expect(result.current.items[0].pinnedAt).toBeNull()
    await act(async () => { d.reject(new Error('Item is no longer in the queue')); await pending })
    expect(result.current.items[0]).toMatchObject({ pinnedAt: '2026-11-08T00:00:00Z', shortlistDismissedAt: null })
  })

  it('onPin rolls back when pinItem rejects', async () => {
    api.pinItem.mockRejectedValue(new Error('nope'))
    const { result } = setup()
    await act(() => result.current.actions.onPin(result.current.items[1]))
    expect(result.current.items[1].pinnedAt).toBeNull()
    expect(api.pinItem).toHaveBeenCalledWith(2)
  })

  it('onPin keeps the pin and moves the clock forward on success', async () => {
    api.pinItem.mockResolvedValue(undefined)
    const { result } = setup()
    await act(() => result.current.actions.onPin(result.current.items[1]))
    expect(result.current.items[1].pinnedAt).toEqual(expect.any(String))
    expect(result.current.nowMs).toBeGreaterThan(NOW)
  })

  it('a failed action rolls back only its own item', async () => {
    const dismiss = deferred()
    api.dismissItem.mockReturnValue(dismiss.promise)
    api.updateItemStatus.mockResolvedValue(undefined)
    const { result } = setup()
    let pendingDismiss!: Promise<void>
    act(() => { pendingDismiss = result.current.actions.onNotNow(result.current.items[0]) })
    await act(() => result.current.actions.onMarkComplete(result.current.items[1]))
    await act(async () => { dismiss.reject(new Error('boom')); await pendingDismiss })
    expect(result.current.items.map(i => i.id)).toEqual([1, 3])
    expect(result.current.items[0].shortlistDismissedAt).toBeNull()
  })

  it('re-inserts an item a failed complete had removed', async () => {
    api.updateItemStatus.mockRejectedValue(new Error('boom'))
    const { result } = setup()
    await act(() => result.current.actions.onSkip(result.current.items[1]))
    expect(result.current.items.map(i => i.id).sort()).toEqual([1, 2, 3])
  })

  it('loadQueue replaces items and curation and refreshes the clock', async () => {
    const curation = { finishedAt: '2026-11-09T11:45:00Z', picks: [{ id: 9, reason: null }] }
    api.fetchFeedHome.mockResolvedValue({ items: [item(9)], curation })
    const { result } = setup()
    await act(() => result.current.loadQueue())
    expect(result.current.items.map(i => i.id)).toEqual([9])
    expect(result.current.curation).toEqual(curation)
    expect(result.current.nowMs).toBeGreaterThan(NOW)
  })

  it('reports pending actions while one is in flight', async () => {
    const d = deferred()
    api.pinItem.mockReturnValue(d.promise)
    const { result } = setup()
    let pending!: Promise<void>
    act(() => { pending = result.current.actions.onPin(result.current.items[0]) })
    expect(result.current.hasPendingAction()).toBe(true)
    await act(async () => { d.resolve(); await pending })
    expect(result.current.hasPendingAction()).toBe(false)
  })

  it('a background reload that fails keeps the items and sets no error', async () => {
    api.fetchFeedHome.mockRejectedValue(new Error('offline'))
    const { result } = setup()
    await act(() => result.current.loadQueue({ background: true }))
    expect(result.current.error).toBeNull()
    expect(result.current.items.map(i => i.id)).toEqual([1, 2, 3])
  })

  it('a reload while a pin is in flight keeps the optimistic pin', async () => {
    const d = deferred()
    api.pinItem.mockReturnValue(d.promise)
    api.fetchFeedHome.mockResolvedValue({ items: [item(1), item(2), item(3), item(4)], curation: null })
    const { result } = setup()
    let pending!: Promise<boolean>
    act(() => { pending = result.current.actions.onPin(result.current.items[1]) })
    await act(() => result.current.loadQueue())
    expect(result.current.items.find(i => i.id === 2)?.pinnedAt).toEqual(expect.any(String))
    expect(result.current.items.map(i => i.id)).toEqual([1, 2, 3, 4])
    await act(async () => { d.resolve(); await pending })
  })

  it('a reload while a complete is in flight does not bring the item back', async () => {
    const d = deferred()
    api.updateItemStatus.mockReturnValue(d.promise)
    api.fetchFeedHome.mockResolvedValue({ items: [item(1), item(2), item(3)], curation: null })
    const { result } = setup()
    let pending!: Promise<void>
    act(() => { pending = result.current.actions.onMarkComplete(result.current.items[0]) })
    await act(() => result.current.loadQueue())
    expect(result.current.items.map(i => i.id)).toEqual([2, 3])
    await act(async () => { d.resolve(); await pending })
  })

  it('a pin that succeeds while a stale reload is in flight survives the reload', async () => {
    const pin = deferred()
    api.pinItem.mockReturnValue(pin.promise)
    let resolveFetch!: (v: unknown) => void
    api.fetchFeedHome.mockReturnValue(new Promise(r => { resolveFetch = r }))
    const { result } = setup()
    let pendingPin!: Promise<boolean>
    let pendingLoad!: Promise<void>
    act(() => { pendingPin = result.current.actions.onPin(result.current.items[1]) })
    act(() => { pendingLoad = result.current.loadQueue({ background: true }) })
    await act(async () => { pin.resolve(); await pendingPin })
    await act(async () => { resolveFetch({ items: [item(1), item(2), item(3)], curation: null }); await pendingLoad })
    expect(result.current.items.find(i => i.id === 2)?.pinnedAt).toEqual(expect.any(String))
  })

  it('an action started during a reload survives the stale snapshot', async () => {
    api.updateItemStatus.mockResolvedValue(undefined)
    let resolveFetch!: (v: unknown) => void
    api.fetchFeedHome.mockReturnValue(new Promise(r => { resolveFetch = r }))
    const { result } = setup()
    let pendingLoad!: Promise<void>
    act(() => { pendingLoad = result.current.loadQueue({ background: true }) })
    await act(() => result.current.actions.onMarkComplete(result.current.items[0]))
    await act(async () => { resolveFetch({ items: [item(1), item(2), item(3)], curation: null }); await pendingLoad })
    expect(result.current.items.map(i => i.id)).toEqual([2, 3])
  })

  it('a convert that 409s with no active request reloads the real state after the action ends', async () => {
    api.requestAwcConversion.mockResolvedValue({ conversion: null, alreadyActive: true })
    let resolveFetch!: (v: unknown) => void
    api.fetchFeedHome.mockReturnValue(new Promise(r => { resolveFetch = r }))
    const withArticle = item(2, { sources: [{ id: 20, platform: 'Substack', link: 'https://example.substack.com/p/x', messageId: null, isPrimary: true, createdAt: '2026-11-01T00:00:00Z', sourceLabel: null }] })
    const { result } = setup([item(1), withArticle, item(3)])
    await act(() => result.current.actions.onConvert(result.current.items[1]))
    expect(result.current.items[1].awcConversion?.status).toBe('queued')
    await act(async () => { resolveFetch({ items: [item(1), withArticle, item(3)], curation: null }) })
    expect(api.fetchFeedHome).toHaveBeenCalledTimes(1)
    expect(result.current.items[1].awcConversion ?? null).toBeNull()
  })

})
