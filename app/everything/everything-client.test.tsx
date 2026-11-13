import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, act } from '@testing-library/react'
import type { QueueItem } from '@/lib/queue-client'
import { buildShortlist, type Curation } from '@/lib/shortlist'

const api = vi.hoisted(() => ({
  updateItemStatus: vi.fn(),
  pinItem: vi.fn(),
  dismissItem: vi.fn(),
  fetchFeedHome: vi.fn(),
  markSentToReader: vi.fn(),
  requestAwcConversion: vi.fn(),
}))
vi.mock('@/lib/queue-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/queue-client')>()),
  ...api,
}))
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/lib/awc/polling', () => ({ useAwcConversionPolling: () => ({ stale: false, checkedAt: 0 }) }))

import { EverythingClient } from './everything-client'

const SERVER_NOW = Date.parse('2026-11-09T12:00:00Z')

function item(id: number, over: Partial<QueueItem> = {}): QueueItem {
  return {
    id, title: `Item ${id}`, author: id % 2 ? 'Odd Author' : 'Even Author',
    publishedOn: new Date(SERVER_NOW - id * 86_400_000).toISOString(),
    status: '', queuePosition: id === 12 ? 1 : null, positionConfirmed: id === 12, progress: null, addedBy: null,
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', statusChangedAt: null,
    kind: 'feed', sentToReaderAt: null, imageUrl: null, wordCount: null, durationSeconds: null,
    sources: [{ id, platform: 'Substack', link: `https://example.com/${id}`, messageId: null, isPrimary: true, createdAt: '2026-10-01T00:00:00Z', sourceLabel: null }],
    platform: 'Substack', link: `https://example.com/${id}`,
    pinnedAt: null, shortlistDismissedAt: null, ...over,
  }
}

const items = Array.from({ length: 12 }, (_, i) => item(i + 1))
const curation: Curation = { finishedAt: '2026-11-09T11:00:00Z', picks: [{ id: 11, reason: 'Why' }, { id: 4, reason: null }] }

const titles = () => screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)

const fetchMock = vi.fn()

function renderPile(newSince: string | null = null) {
  return render(<EverythingClient initialItems={items} initialCuration={curation} serverNow={SERVER_NOW} newSince={newSince} />)
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  toast.mockClear()
  toast.success.mockClear()
  toast.error.mockClear()
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

describe('EverythingClient (#377)', () => {
  it('lists every active item newest first, ignoring a legacy position 1', () => {
    renderPile()
    expect(titles()).toEqual(items.map(i => i.title))
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
  })

  it('reorders oldest first from the sort menu', () => {
    renderPile()
    const triggers = screen.getAllByRole('button').filter(b => b.getAttribute('aria-haspopup') === 'menu')
    fireEvent.pointerDown(triggers[0], { button: 0, ctrlKey: false })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Oldest first' }))
    expect(titles()).toEqual([...items].reverse().map(i => i.title))
  })

  it('puts the PICK pill exactly on the items home shows', () => {
    renderPile()
    const onHome = new Set(buildShortlist(items, curation, SERVER_NOW).map(e => e.item.id))
    expect(onHome.size).toBe(8)
    for (const it of items) {
      const card = screen.getByText(it.title).closest('.rounded-xl') as HTMLElement
      expect(within(card).queryByText('PICK') !== null).toBe(onHome.has(it.id))
    }
  })

  it('narrows the list with search', () => {
    renderPile()
    fireEvent.change(screen.getByPlaceholderText('Search everything'), { target: { value: 'Item 1' } })
    expect(titles()).toEqual(['Item 1', 'Item 10', 'Item 11', 'Item 12'])
  })

  it('tapping a card pins it and says so', async () => {
    api.pinItem.mockResolvedValue(undefined)
    renderPile()
    await act(async () => { fireEvent.click(screen.getByText('Item 9')) })
    expect(api.pinItem).toHaveBeenCalledWith(9)
    expect(toast.success).toHaveBeenCalledWith('Pinned to the top of your picks')
    const card = screen.getByText('Item 9').closest('.rounded-xl') as HTMLElement
    expect(within(card).getByText('PICK')).toBeTruthy()
  })

  it('does not claim a pin that failed', async () => {
    api.pinItem.mockRejectedValue(new Error('Item is no longer in the queue'))
    renderPile()
    await act(async () => { fireEvent.click(screen.getByText('Item 9')) })
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Item is no longer in the queue')
  })

  it('records this visit with the server render time', () => {
    renderPile('2026-11-08T12:00:00.000Z')
    const call = fetchMock.mock.calls.find(c => c[0] === '/api/settings/everything-seen')!
    expect(JSON.parse(call[1].body)).toEqual({ seenAt: new Date(SERVER_NOW).toISOString() })
  })

  it('marks items added since the last visit as NEW', () => {
    // Item n was published n days ago; createdAt is 2026-10-01 for all, so
    // make two of them newer than the last visit.
    const fresh = items.map(i => (i.id <= 2 ? { ...i, createdAt: '2026-11-09T10:00:00Z' } : i))
    render(<EverythingClient initialItems={fresh} initialCuration={curation} serverNow={SERVER_NOW} newSince="2026-11-09T00:00:00Z" />)
    expect(screen.getAllByText('NEW')).toHaveLength(2)
  })

  it('marks nothing NEW on the first ever visit', () => {
    renderPile(null)
    expect(screen.queryByText('NEW')).toBeNull()
  })

  it('Not now on a pick takes it off home and says so', async () => {
    api.dismissItem.mockResolvedValue(undefined)
    renderPile()
    const card = screen.getByText('Item 11').closest('[data-card]') as HTMLElement
    expect(card.getAttribute('data-pick')).toBe('true')
    const trigger = within(card).getAllByRole('button').find(b => b.getAttribute('aria-haspopup') === 'menu')!
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Not now' })) })
    expect(api.dismissItem).toHaveBeenCalledWith(11)
    expect(toast.success).toHaveBeenCalledWith('Off your picks for 3 weeks')
    expect((screen.getByText('Item 11').closest('[data-card]') as HTMLElement).getAttribute('data-pick')).toBe('false')
  })
})
