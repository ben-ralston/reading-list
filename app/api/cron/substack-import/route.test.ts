import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from './route'
import type { RssFeed } from '@/lib/rss/feeds-repo'

const mockFetchSubs = vi.fn()
vi.mock('@/lib/substack/subscriptions', () => ({
  fetchSubstackSubscriptions: (...a: unknown[]) => mockFetchSubs(...a),
}))

const mockListFeeds = vi.fn()
const mockInsertFeed = vi.fn()
const mockUpdateFeed = vi.fn()
vi.mock('@/lib/rss/feeds-repo', () => ({
  listFeeds: (...a: unknown[]) => mockListFeeds(...a),
  insertFeed: (...a: unknown[]) => mockInsertFeed(...a),
  updateFeed: (...a: unknown[]) => mockUpdateFeed(...a),
}))

// Capture the sync_logs insert payload so tests can assert on what was logged.
let lastSyncLogInsert: Record<string, unknown> | null = null
const mockFrom = vi.fn()
vi.mock('@/lib/supabase', () => ({
  supabase: { from: (...a: unknown[]) => mockFrom(...a) },
}))

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn().mockResolvedValue({ isAuthenticated: false }),
}))

vi.mock('@/lib/app-settings', () => ({
  getDefaultBackfillDays: vi.fn().mockResolvedValue(90),
}))

const mockLogError = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/logger', () => ({
  logError: (...a: unknown[]) => mockLogError(...a),
}))

const MOCK_SECRET = 'test-secret-123'

function createRequest(bearerToken?: string): Request {
  const headers: Record<string, string> = {}
  if (bearerToken) headers['authorization'] = `Bearer ${bearerToken}`
  return new Request('http://localhost/api/cron/substack-import', { method: 'GET', headers })
}

function feed(partial: Partial<RssFeed> & { url: string }): RssFeed {
  return {
    id: 1, label: '', authorName: null, platform: 'Substack', feedType: 'substack',
    active: true, source: 'manual', createdAt: 't', updatedAt: 't', lastFetchedAt: null,
    lastSuccessAt: null, lastError: null, lastErrorAt: null, lastItemCount: null,
    consecutiveErrors: 0, backfillDays: null, ...partial,
  }
}

function sub(name: string, subdomain: string) {
  return { name, subdomain, feedUrl: `https://${subdomain}.substack.com/feed` }
}

beforeEach(() => {
  mockFetchSubs.mockReset()
  mockListFeeds.mockReset()
  mockInsertFeed.mockReset()
  mockUpdateFeed.mockReset()
  mockFrom.mockReset()
  lastSyncLogInsert = null
  process.env.SYNC_API_SECRET = MOCK_SECRET
  process.env.SUBSTACK_HANDLE = 'examplereader'
  mockListFeeds.mockResolvedValue([])
  mockInsertFeed.mockResolvedValue(undefined)
  mockUpdateFeed.mockResolvedValue(undefined)
  mockFetchSubs.mockResolvedValue({ subs: [], truncated: false })
  mockLogError.mockClear()
  mockFrom.mockImplementation((table: string) => {
    if (table === 'sync_logs') {
      return { insert: (payload: Record<string, unknown>) => { lastSyncLogInsert = payload; return Promise.resolve({ error: null }) } }
    }
    return { insert: () => Promise.resolve({ error: null }) }
  })
})

describe('GET /api/cron/substack-import', () => {
  it('returns 401 without auth', async () => {
    const res = await GET(createRequest())
    expect(res.status).toBe(401)
    expect(mockFetchSubs).not.toHaveBeenCalled()
  })

  it('no-ops when SUBSTACK_HANDLE is not configured', async () => {
    delete process.env.SUBSTACK_HANDLE
    const res = await GET(createRequest(MOCK_SECRET))
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(mockFetchSubs).not.toHaveBeenCalled()
    expect(mockInsertFeed).not.toHaveBeenCalled()
  })

  it('inserts only new subscription URLs as substack_auto, skipping existing ones', async () => {
    mockFetchSubs.mockResolvedValue({
      subs: [sub('Astral Codex Ten', 'astralcodexten'), sub('Freddie deBoer', 'freddiedeboer')],
      truncated: false,
    })
    mockListFeeds.mockResolvedValue([
      feed({ id: 1, url: 'https://astralcodexten.substack.com/feed', source: 'manual' }),
    ])

    const res = await GET(createRequest(MOCK_SECRET))
    const body = await res.json()

    expect(body.ok).toBe(true)
    expect(body.added).toBe(1)
    expect(mockInsertFeed).toHaveBeenCalledTimes(1)
    expect(mockInsertFeed).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://freddiedeboer.substack.com/feed',
        source: 'substack_auto',
        feedType: 'substack',
      }),
    )
  })

  it('inserts new feeds with the global default backfill window', async () => {
    mockFetchSubs.mockResolvedValue({ subs: [sub('New One', 'newone')], truncated: false })
    mockListFeeds.mockResolvedValue([]) // nothing tracked yet → it's inserted

    const res = await GET(createRequest(MOCK_SECRET))
    const body = await res.json()

    expect(body.added).toBe(1)
    expect(mockInsertFeed).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'substack_auto', backfillDays: 90 }),
    )
  })

  it('auto-disables a substack_auto feed no longer in the subscription set', async () => {
    mockFetchSubs.mockResolvedValue({ subs: [sub('Kept', 'kept')], truncated: false })
    mockListFeeds.mockResolvedValue([
      feed({ id: 1, url: 'https://kept.substack.com/feed', source: 'substack_auto' }),
      feed({ id: 2, url: 'https://gone.substack.com/feed', source: 'substack_auto', active: true }),
    ])

    const res = await GET(createRequest(MOCK_SECRET))
    const body = await res.json()

    expect(body.disabled).toBe(1)
    expect(mockUpdateFeed).toHaveBeenCalledTimes(1)
    expect(mockUpdateFeed).toHaveBeenCalledWith(2, { active: false })
  })

  it('never auto-disables manual feeds, even when absent from subscriptions', async () => {
    mockFetchSubs.mockResolvedValue({ subs: [sub('Auto', 'auto')], truncated: false })
    mockListFeeds.mockResolvedValue([
      feed({ id: 1, url: 'https://auto.substack.com/feed', source: 'substack_auto' }),
      feed({ id: 2, url: 'https://manual.substack.com/feed', source: 'manual', active: true }),
    ])

    const res = await GET(createRequest(MOCK_SECRET))
    const body = await res.json()

    expect(body.disabled).toBe(0)
    expect(mockUpdateFeed).not.toHaveBeenCalled()
  })

  it('skips the disable pass entirely when the response is truncated', async () => {
    mockFetchSubs.mockResolvedValue({ subs: [sub('Kept', 'kept')], truncated: true })
    mockListFeeds.mockResolvedValue([
      feed({ id: 2, url: 'https://gone.substack.com/feed', source: 'substack_auto', active: true }),
    ])

    const res = await GET(createRequest(MOCK_SECRET))
    const body = await res.json()

    expect(body.disableSkipped).toBe(true)
    expect(mockUpdateFeed).not.toHaveBeenCalled()
  })

  it('skips the disable pass when the subscription list is empty', async () => {
    mockFetchSubs.mockResolvedValue({ subs: [], truncated: false })
    mockListFeeds.mockResolvedValue([
      feed({ id: 2, url: 'https://gone.substack.com/feed', source: 'substack_auto', active: true }),
    ])

    const res = await GET(createRequest(MOCK_SECRET))
    const body = await res.json()

    expect(body.disableSkipped).toBe(true)
    expect(mockUpdateFeed).not.toHaveBeenCalled()
  })

  it('never re-enables a disabled substack_auto feed that is still subscribed', async () => {
    mockFetchSubs.mockResolvedValue({ subs: [sub('Kept', 'kept')], truncated: false })
    mockListFeeds.mockResolvedValue([
      feed({ id: 1, url: 'https://kept.substack.com/feed', source: 'substack_auto', active: false }),
    ])

    const res = await GET(createRequest(MOCK_SECRET))
    const body = await res.json()

    expect(body.added).toBe(0)
    expect(body.disabled).toBe(0)
    expect(mockInsertFeed).not.toHaveBeenCalled()
    expect(mockUpdateFeed).not.toHaveBeenCalled()
  })

  it('logs a sync_logs error row and does not mutate feeds when the fetch fails', async () => {
    mockFetchSubs.mockRejectedValue(new Error('HTTP 429'))
    mockListFeeds.mockResolvedValue([])

    const res = await GET(createRequest(MOCK_SECRET))
    const body = await res.json()

    expect(body.ok).toBe(false)
    expect(mockInsertFeed).not.toHaveBeenCalled()
    expect(mockUpdateFeed).not.toHaveBeenCalled()
    expect(lastSyncLogInsert).toMatchObject({ source: 'substack_import', status: 'error' })
  })

  it('writes a substack_import sync_logs row on success', async () => {
    mockFetchSubs.mockResolvedValue({ subs: [sub('New', 'new')], truncated: false })
    mockListFeeds.mockResolvedValue([])

    await GET(createRequest(MOCK_SECRET))

    expect(lastSyncLogInsert).toMatchObject({ source: 'substack_import', status: 'success' })
  })

  it('logs status success (not partial) on a truncated snapshot', async () => {
    // A truncated response means the FETCH succeeded; the importer just skips the
    // (destructive) disable pass. The status page treats 'partial' as "feeds failed",
    // so a truncated run must log 'success' and record the skip in metadata instead.
    mockFetchSubs.mockResolvedValue({ subs: [sub('Kept', 'kept')], truncated: true })
    mockListFeeds.mockResolvedValue([])

    await GET(createRequest(MOCK_SECRET))

    expect(lastSyncLogInsert).toMatchObject({ source: 'substack_import', status: 'success' })
    expect((lastSyncLogInsert?.metadata as Record<string, unknown>)?.truncated).toBe(true)
    expect((lastSyncLogInsert?.metadata as Record<string, unknown>)?.disableSkipped).toBe(true)
  })

  describe('log service (#269)', () => {
    it('reports a subscription-fetch failure to the log service', async () => {
      // Same setup as "logs a sync_logs error row and does not mutate feeds when the fetch fails".
      mockFetchSubs.mockRejectedValue(new Error('HTTP 429'))
      mockListFeeds.mockResolvedValue([])

      await GET(createRequest(MOCK_SECRET))

      expect(mockLogError).toHaveBeenCalledWith(
        'substack-import',
        expect.anything(),
      )
    })

    it('reports a sync_logs insert failure', async () => {
      // Healthy import but sync_logs .insert returns { error: {...} }.
      mockFrom.mockImplementation((table: string) => {
        if (table === 'sync_logs') {
          return { insert: (payload: Record<string, unknown>) => {
            lastSyncLogInsert = payload
            return Promise.resolve({ error: { message: 'insert failed' } })
          } }
        }
        return { insert: () => Promise.resolve({ error: null }) }
      })
      mockFetchSubs.mockResolvedValue({ subs: [sub('New', 'new')], truncated: false })
      mockListFeeds.mockResolvedValue([])

      await GET(createRequest(MOCK_SECRET))

      expect(mockLogError).toHaveBeenCalledWith(
        'substack-import',
        expect.anything(),
        expect.objectContaining({ blindSpot: 'sync_logs-write' }),
      )
    })

    it('does not log on a healthy run', async () => {
      mockFetchSubs.mockResolvedValue({ subs: [sub('New', 'new')], truncated: false })
      mockListFeeds.mockResolvedValue([])

      await GET(createRequest(MOCK_SECRET))

      expect(mockLogError).not.toHaveBeenCalled()
    })
  })
})
