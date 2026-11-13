import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within, act } from '@testing-library/react'
import type { QueueItem } from '@/lib/queue-client'
import type { Curation } from '@/lib/shortlist'

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
const fetchWithRetry = vi.hoisted(() => vi.fn())
vi.mock('@/lib/fetch-with-retry', () => ({ fetchWithRetry }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }) }))
vi.mock('@/lib/awc/polling', () => ({ useAwcConversionPolling: () => ({ stale: false, checkedAt: 0 }) }))

import { HomeClient } from './home-client'

const SERVER_NOW = Date.parse('2026-11-09T12:00:00Z')

function item(id: number, over: Partial<QueueItem> = {}): QueueItem {
  return {
    id, title: `Item ${id}`, author: `Author ${id}`, publishedOn: null, status: '', queuePosition: null,
    positionConfirmed: false, progress: null, addedBy: null,
    createdAt: new Date(SERVER_NOW - (100 - id) * 3_600_000).toISOString(),
    updatedAt: '2026-11-01T00:00:00Z', statusChangedAt: null, kind: 'feed', sentToReaderAt: null,
    imageUrl: null, wordCount: null, durationSeconds: null,
    sources: [{ id, platform: 'Substack', link: `https://example.com/${id}`, messageId: null, isPrimary: true, createdAt: '2026-11-01T00:00:00Z', sourceLabel: null }],
    platform: 'Substack', link: `https://example.com/${id}`,
    pinnedAt: null, shortlistDismissedAt: null, ...over,
  }
}

const curation: Curation = {
  finishedAt: new Date(SERVER_NOW - 2 * 3_600_000).toISOString(),
  picks: [{ id: 3, reason: 'New episode' }, { id: 7, reason: null }],
}

function tenItems() {
  return Array.from({ length: 10 }, (_, i) => item(i + 1, i + 1 === 5 ? { pinnedAt: '2026-11-09T11:00:00Z' } : {}))
}

function renderHome(items = tenItems(), cur: Curation | null = curation) {
  return render(<HomeClient initialItems={items} initialCuration={cur} serverNow={SERVER_NOW} />)
}

const listTitles = () => screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)
const heroTitle = () => screen.getByRole('heading', { level: 1 }).textContent

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  fetchWithRetry.mockReset()
  localStorage.clear()
  localStorage.setItem('last-spotify-sync', String(Date.now()))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('HomeClient (#377)', () => {
  it('shows pins, then picks, then fallback, with the first as the hero', () => {
    renderHome()
    expect(heroTitle()).toBe('Item 5')
    const titles = listTitles()
    expect(titles.slice(0, 2)).toEqual(['Item 3', 'Item 7'])
    expect(titles).toHaveLength(7)
    expect(screen.getByText('New episode')).toBeTruthy()
    expect(screen.getByText('Picks updated 2h ago')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Everything else · 2 items' })).toBeTruthy()
  })

  it('promotes the next entry as soon as the hero is completed, with no refetch', async () => {
    api.updateItemStatus.mockResolvedValue(undefined)
    renderHome()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Complete' })) })
    expect(heroTitle()).toBe('Item 3')
    expect(api.updateItemStatus).toHaveBeenCalledWith(5, 'Completed')
    expect(api.fetchFeedHome).not.toHaveBeenCalled()
  })

  it('Not now removes the card and pulls in the next one', async () => {
    api.dismissItem.mockResolvedValue(undefined)
    renderHome()
    const before = listTitles()
    const card = screen.getByText('Item 7').closest('.rounded-xl') as HTMLElement
    const trigger = within(card).getAllByRole('button').find(b => b.getAttribute('aria-haspopup') === 'menu')!
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Not now' })) })
    const after = listTitles()
    expect(after).not.toContain('Item 7')
    expect(after).toHaveLength(7)
    expect(after.filter(t => !before.includes(t))).toHaveLength(1)
    expect(api.dismissItem).toHaveBeenCalledWith(7)
  })

  it('renders the same list and freshness from the server clock whatever the wall clock', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(SERVER_NOW + 5 * 3_600_000)
    const first = renderHome()
    const a = { titles: listTitles(), hero: heroTitle(), text: first.container.textContent }
    first.unmount()
    vi.setSystemTime(SERVER_NOW + 40 * 86_400_000)
    renderHome()
    expect({ titles: listTitles(), hero: heroTitle() }).toEqual({ titles: a.titles, hero: a.hero })
    expect(screen.getByText('Picks updated 2h ago')).toBeTruthy()
    expect(a.text).toContain('Picks updated 2h ago')
  })

  it('does not read a saved sort preference', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem')
    renderHome()
    expect(spy.mock.calls.map(c => c[0])).not.toContain('queue-sort-direction')
    spy.mockRestore()
  })

  it('reloads the feed when the tab returns after 5+ minutes, even if Spotify changed nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(SERVER_NOW)
    localStorage.setItem('last-spotify-sync', String(SERVER_NOW))
    fetchWithRetry.mockResolvedValue(new Response(JSON.stringify({ success: true, processed: 0, created: 0, updated: 0, skipped: 0 }), { status: 200 }))
    api.fetchFeedHome.mockResolvedValue({ items: [item(42, { title: 'Fresh Pick' })], curation: { finishedAt: new Date(SERVER_NOW + 6 * 60_000).toISOString(), picks: [{ id: 42, reason: null }] } })
    renderHome()
    const hidden = vi.spyOn(document, 'hidden', 'get')
    hidden.mockReturnValue(true)
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    vi.setSystemTime(SERVER_NOW + 6 * 60_000)
    hidden.mockReturnValue(false)
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => {})
    expect(api.fetchFeedHome).toHaveBeenCalled()
    expect(heroTitle()).toBe('Fresh Pick')
    hidden.mockRestore()
  })

  it('reloads once, not twice, when the refocus sync already reloaded', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(SERVER_NOW)
    localStorage.setItem('last-spotify-sync', String(SERVER_NOW))
    fetchWithRetry.mockResolvedValue(new Response(JSON.stringify({ success: true, processed: 2, created: 1, updated: 1, skipped: 0 }), { status: 200 }))
    api.fetchFeedHome.mockResolvedValue({ items: tenItems(), curation })
    renderHome()
    const hidden = vi.spyOn(document, 'hidden', 'get')
    hidden.mockReturnValue(true)
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    vi.setSystemTime(SERVER_NOW + 6 * 60_000)
    hidden.mockReturnValue(false)
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => {})
    expect(api.fetchFeedHome).toHaveBeenCalledTimes(1)
    hidden.mockRestore()
  })

  it('keeps the list on screen when a background reload fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(SERVER_NOW)
    localStorage.setItem('last-spotify-sync', String(SERVER_NOW + 60 * 60_000))
    api.fetchFeedHome.mockRejectedValue(new Error('offline'))
    renderHome()
    const hidden = vi.spyOn(document, 'hidden', 'get')
    hidden.mockReturnValue(true)
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    vi.setSystemTime(SERVER_NOW + 6 * 60_000)
    hidden.mockReturnValue(false)
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => {})
    expect(api.fetchFeedHome).toHaveBeenCalled()
    expect(heroTitle()).toBe('Item 5')
    expect(screen.queryByText(/Failed to load queue/)).toBeNull()
    hidden.mockRestore()
  })
})
