import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from './route'

// Default fixtures have a non-null lastSuccessAt: these tests exercise the
// steady-state (last_success_at cutoff) path. First-poll behavior (#164) is covered in
// its own describe block with lastSuccessAt: null.
const DAY_MS = 24 * 60 * 60 * 1000
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString()

const TEST_FEEDS = [
  { id: 1, url: 'https://thezvi.substack.com/feed', label: 'Zvi', authorName: 'Zvi Mowshowitz',
    platform: 'Substack', feedType: 'substack', active: true, createdAt: 't', updatedAt: 't',
    lastFetchedAt: null, lastSuccessAt: '2026-01-01T00:00:00.000Z', lastError: null, lastErrorAt: null,
    lastItemCount: null, consecutiveErrors: 0, backfillDays: null },
  { id: 2, url: 'https://feeds.buzzsprout.com/2037297.rss', label: 'LessWrong',
    authorName: 'LessWrong (Curated & Popular)', platform: 'LessWrong', feedType: 'lesswrong',
    active: true, createdAt: 't', updatedAt: 't', lastFetchedAt: null, lastSuccessAt: '2026-01-01T00:00:00.000Z',
    lastError: null, lastErrorAt: null, lastItemCount: null, consecutiveErrors: 0, backfillDays: null },
]
const mockListFeeds = vi.fn()
const mockRecordSuccess = vi.fn()
const mockRecordError = vi.fn()
vi.mock('@/lib/rss/feeds-repo', () => ({
  listFeeds: (...a: unknown[]) => mockListFeeds(...a),
  recordFeedSuccess: (...a: unknown[]) => mockRecordSuccess(...a),
  recordFeedError: (...a: unknown[]) => mockRecordError(...a),
}))

const mockLogError = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/logger', () => ({
  logError: (...a: unknown[]) => mockLogError(...a),
}))

const MOCK_SECRET = 'test-secret-123'

// Mock Supabase client
const mockFrom = vi.fn()
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: vi.fn(),
  },
}))

// Mock next/server's after()
vi.mock('next/server', async () => {
  const actual = await vi.importActual('next/server')
  return { ...actual, after: vi.fn() }
})

// Mock summary generation
vi.mock('@/lib/summary', () => ({
  generateSummary: vi.fn().mockResolvedValue({ summary: 'test', generatedAt: '' }),
}))

// Mock the SSRF-guarded feed fetcher (#206) — replaces the old rss-parser
// parseURL mock; fetchFeed(url, parser) keeps url as the first argument.
const mockFetchFeed = vi.fn()
vi.mock('@/lib/rss/fetch-feed', () => ({
  fetchFeed: (...args: unknown[]) => mockFetchFeed(...args),
}))

// Stub the og:image network fallback (#167) so the create path stays hermetic
// (no real HTTP to feed article URLs). The cheap, synchronous enrichFromRssItem
// used by parseRssItems is kept real via importOriginal.
const mockEnrichFromUrl = vi.fn().mockResolvedValue({ imageUrl: null, wordCount: null })
vi.mock('@/lib/rss/enrich', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rss/enrich')>()
  return { ...actual, enrichFromUrl: (...args: unknown[]) => mockEnrichFromUrl(...args) }
})

// Mock sync matching functions
const mockFindMatchingContent = vi.fn()
const mockCreateContent = vi.fn()
const mockEnsureRssSource = vi.fn()
vi.mock('@/lib/sync/matching', () => ({
  findMatchingContent: (...args: unknown[]) => mockFindMatchingContent(...args),
  createContent: (...args: unknown[]) => mockCreateContent(...args),
  ensureRssSource: (...args: unknown[]) => mockEnsureRssSource(...args),
  shouldAutoAdd: vi.fn().mockReturnValue(true),
}))

// Mock auth
vi.mock('@/lib/auth', () => ({
  getSession: vi.fn().mockResolvedValue({ isAuthenticated: false }),
}))

// Helper to create request with auth
function createRequest(bearerToken?: string): Request {
  const headers: Record<string, string> = {}
  if (bearerToken) {
    headers['authorization'] = `Bearer ${bearerToken}`
  }
  return new Request('http://localhost/api/cron/rss-sync', {
    method: 'GET',
    headers,
  })
}

/**
 * Creates a deeply chainable mock object where every method returns itself,
 * and terminal methods (single, maybeSingle) resolve with the provided value.
 */
function createDeepChain(terminalValue: { data?: unknown; error?: unknown } = { data: null, error: null }) {
  const chain: Record<string, unknown> = {}
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_target, prop) {
      if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined
      if (prop === 'single' || prop === 'maybeSingle') {
        return vi.fn().mockResolvedValue(terminalValue)
      }
      return vi.fn().mockReturnValue(new Proxy({}, handler))
    },
  }
  return new Proxy(chain, handler)
}

/**
 * Captures the most recent sync_logs update payload so tests can assert on it.
 * Reset in beforeEach via setupSyncLogsMock().
 */
let lastSyncLogUpdate: Record<string, unknown> | null = null

/**
 * Sets up the standard Supabase mock for sync_logs operations.
 * Specific-cases the sync_logs table so update payloads can be inspected,
 * and falls back to a generic deep chain for everything else.
 *
 * Pass `updateError` to simulate a Supabase write failure on the finalizing
 * update — used by the silent-failure regression test for #132.
 *
 * Reads of sync_logs throw: the ingest cutoff is per-feed (last_success_at)
 * and must never be derived from sync_logs again — a transient read error
 * there once meant "never synced" and ingested every back catalog (#287).
 */
function setupSyncLogsMock(options: { updateError?: { message: string } } = {}) {
  lastSyncLogUpdate = null
  mockFrom.mockImplementation((table: string) => {
    if (table === 'sync_logs') {
      return {
        // insert → select('id') → single() — creates the sync_log row
        insert: () => ({
          select: () => ({
            single: () => Promise.resolve({ data: { id: 1 }, error: null }),
          }),
        }),
        select: () => {
          throw new Error('sync_logs must not be read to derive the ingest cutoff (#287)')
        },
        // update → eq — finalizes the sync_log
        update: (payload: Record<string, unknown>) => {
          lastSyncLogUpdate = payload
          return { eq: () => Promise.resolve({ error: options.updateError ?? null }) }
        },
      }
    }
    // Anything else the route might touch falls through to the deep proxy.
    return createDeepChain({ data: { id: 1, completed_at: null }, error: null })
  })
}

describe('GET /api/cron/rss-sync', () => {
  beforeEach(() => {
    // Clear call history but preserve mock implementations set in vi.mock() factories
    mockFrom.mockClear()
    mockFetchFeed.mockClear()
    mockFindMatchingContent.mockClear()
    mockCreateContent.mockClear()
    mockEnsureRssSource.mockClear()
    mockEnrichFromUrl.mockClear()
    mockRecordSuccess.mockReset()
    mockRecordError.mockReset()
    mockLogError.mockClear()
    process.env.SYNC_API_SECRET = MOCK_SECRET
    // Safe defaults
    mockFetchFeed.mockResolvedValue({ items: [] })
    mockFindMatchingContent.mockResolvedValue(null)
    mockCreateContent.mockResolvedValue(1)
    mockEnsureRssSource.mockResolvedValue('unchanged')
    mockListFeeds.mockResolvedValue(TEST_FEEDS)
    mockRecordSuccess.mockResolvedValue(undefined)
    mockRecordError.mockResolvedValue(undefined)
    setupSyncLogsMock()
  })

  it('returns 401 without auth', async () => {
    const response = await GET(createRequest())
    expect(response.status).toBe(401)
  })

  it('returns 401 with wrong bearer token', async () => {
    const response = await GET(createRequest('wrong-token'))
    expect(response.status).toBe(401)
  })

  it('authenticates with correct bearer token and returns success', async () => {
    const response = await GET(createRequest(MOCK_SECRET))
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body.success).toBe(true)
    expect(body.feedErrors).toBe(0)
    expect(mockRecordSuccess).toHaveBeenCalled()
  })

  it('processes new RSS items and creates content', async () => {
    // First feed returns an item, rest return empty (default)
    mockFetchFeed
      .mockResolvedValueOnce({
        items: [{
          title: 'New Post',
          link: 'https://thezvi.substack.com/p/new-post',
          isoDate: '2026-03-30T12:00:00.000Z',
        }],
      })

    const response = await GET(createRequest(MOCK_SECRET))
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body.success).toBe(true)
    expect(body.created).toBe(1)
    expect(mockCreateContent).toHaveBeenCalledTimes(1)
  })

  it('runs the og:image fallback for created items and forwards the result (#167)', async () => {
    mockFetchFeed.mockResolvedValueOnce({
      items: [{
        title: 'Imageless Post',
        link: 'https://thezvi.substack.com/p/imageless',
        isoDate: '2026-03-30T12:00:00.000Z',
      }],
    })
    mockEnrichFromUrl.mockResolvedValueOnce({ imageUrl: 'https://cdn.example.com/og.jpg', wordCount: 1234 })

    const response = await GET(createRequest(MOCK_SECRET))
    expect(response.status).toBe(200)

    // Fallback fired with the item's link, and its result reached createContent.
    expect(mockEnrichFromUrl).toHaveBeenCalledWith('https://thezvi.substack.com/p/imageless')
    expect(mockCreateContent).toHaveBeenCalledWith(
      expect.objectContaining({ imageUrl: 'https://cdn.example.com/og.jpg', wordCount: 1234 }),
      'rss',
      expect.anything(),
    )
  })

  it('skips the og:image fallback when the item already has a cheap image (#167)', async () => {
    // YouTube items get a derived thumbnail synchronously, so no network fallback.
    mockFetchFeed.mockResolvedValueOnce({
      items: [{
        title: 'Video Post',
        link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        isoDate: '2026-03-30T12:00:00.000Z',
      }],
    })

    const response = await GET(createRequest(MOCK_SECRET))
    expect(response.status).toBe(200)
    expect(mockEnrichFromUrl).not.toHaveBeenCalled()
    expect(mockCreateContent).toHaveBeenCalledWith(
      expect.objectContaining({ imageUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' }),
      'rss',
      expect.anything(),
    )
  })

  it('skips items that already exist', async () => {
    mockFetchFeed
      .mockResolvedValueOnce({
        items: [{
          title: 'Existing Post',
          link: 'https://thezvi.substack.com/p/existing',
          isoDate: '2026-03-30T12:00:00.000Z',
        }],
      })

    // Item already exists
    mockFindMatchingContent.mockResolvedValue({ contentItemId: 1, action: 'update' })

    const response = await GET(createRequest(MOCK_SECRET))
    const body = await response.json()

    expect(body.success).toBe(true)
    expect(body.created).toBe(0)
    expect(body.skipped).toBe(1)
    expect(mockCreateContent).not.toHaveBeenCalled()
  })

  it('attaches RSS source on match and reports sourcesAttached', async () => {
    mockFetchFeed.mockResolvedValueOnce({
      items: [{
        title: 'Existing Post',
        link: 'https://thezvi.substack.com/p/existing',
        isoDate: '2026-03-30T12:00:00.000Z',
      }],
    })
    mockFindMatchingContent.mockResolvedValue({ contentItemId: 42, action: 'update' })
    mockEnsureRssSource.mockResolvedValue('inserted')

    const response = await GET(createRequest(MOCK_SECRET))
    const body = await response.json()

    expect(body.success).toBe(true)
    expect(body.created).toBe(0)
    expect(body.skipped).toBe(1)
    expect(body.sourcesAttached).toBe(1)
    expect(mockEnsureRssSource).toHaveBeenCalledTimes(1)
    expect(mockEnsureRssSource).toHaveBeenCalledWith(
      42,
      'Substack',
      'https://thezvi.substack.com/p/existing',
      undefined,
      expect.anything()
    )
  })

  it('does not increment sourcesAttached when the RSS source is unchanged', async () => {
    mockFetchFeed.mockResolvedValueOnce({
      items: [{
        title: 'Existing Post',
        link: 'https://thezvi.substack.com/p/existing',
        isoDate: '2026-03-30T12:00:00.000Z',
      }],
    })
    mockFindMatchingContent.mockResolvedValue({ contentItemId: 42, action: 'update' })
    mockEnsureRssSource.mockResolvedValue('unchanged')

    const response = await GET(createRequest(MOCK_SECRET))
    const body = await response.json()

    expect(body.sourcesAttached).toBe(0)
    expect(body.skipped).toBe(1)
  })

  it('persists sourcesAttached as items_updated in sync_logs', async () => {
    mockFetchFeed.mockResolvedValueOnce({
      items: [{
        title: 'Existing Post',
        link: 'https://thezvi.substack.com/p/existing',
        isoDate: '2026-03-30T12:00:00.000Z',
      }],
    })
    mockFindMatchingContent.mockResolvedValue({ contentItemId: 42, action: 'update' })
    mockEnsureRssSource.mockResolvedValue('inserted')

    await GET(createRequest(MOCK_SECRET))

    expect(lastSyncLogUpdate).not.toBeNull()
    expect(lastSyncLogUpdate).toMatchObject({
      status: 'success',
      items_updated: 1,
    })
  })

  it('skips LessWrong items with no extractable link and counts them separately', async () => {
    // Real Buzzsprout quirk: some items lack an item-level <link>, and the
    // description has no lesswrong.com/posts/ URL either. Filter early with
    // a named counter instead of letting the RPC throw "Link is required"
    // and getting swallowed by the outer catch.
    mockFetchFeed.mockImplementation((url: string) => {
      if (url === 'https://feeds.buzzsprout.com/2037297.rss') {
        return Promise.resolve({
          items: [{
            title: '"Orphan episode" by Author',
            content: '<p>No LessWrong link in description</p>',
            isoDate: '2026-03-30T12:00:00.000Z',
          }],
        })
      }
      return Promise.resolve({ items: [] })
    })

    const response = await GET(createRequest(MOCK_SECRET))
    const body = await response.json()

    expect(body.success).toBe(true)
    expect(body.created).toBe(0)
    expect(body.skippedMissingLink).toBe(1)
    // The item is filtered before the match/create pipeline runs — neither
    // matching nor creation is attempted (nor the outer try/catch).
    expect(mockFindMatchingContent).not.toHaveBeenCalled()
    expect(mockCreateContent).not.toHaveBeenCalled()
  })

  it('does not filter Substack items with empty links via skippedMissingLink', async () => {
    // Only LW-type feeds hit the named-skip path. Substack items with empty
    // links (rare in practice) flow through the normal pipeline.
    mockFetchFeed.mockImplementation((url: string) => {
      if (url === 'https://thezvi.substack.com/feed') {
        return Promise.resolve({
          items: [{
            title: 'Weird Empty-Link Post',
            // no link
            isoDate: '2026-03-30T12:00:00.000Z',
          }],
        })
      }
      return Promise.resolve({ items: [] })
    })

    const response = await GET(createRequest(MOCK_SECRET))
    const body = await response.json()

    expect(body.skippedMissingLink).toBe(0)
    // findMatchingContent is called for this item (default: returns null → createContent),
    // so the item is NOT filtered by the LW-specific guard.
    expect(mockFindMatchingContent).toHaveBeenCalledTimes(1)
  })

  it('handles individual feed failures gracefully', async () => {
    // First feed fails, rest succeed (default: empty items)
    mockFetchFeed
      .mockRejectedValueOnce(new Error('Network error'))

    const response = await GET(createRequest(MOCK_SECRET))
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body.success).toBe(true)
    expect(body.feedErrors).toBe(1)
    expect(mockRecordError).toHaveBeenCalled()
  })

  it('persists feed_errors=0 and status=success when no feeds fail (#132)', async () => {
    await GET(createRequest(MOCK_SECRET))

    expect(lastSyncLogUpdate).not.toBeNull()
    expect(lastSyncLogUpdate).toMatchObject({
      status: 'success',
      feed_errors: 0,
    })
    // metadata stays sparse on healthy syncs — either absent or null
    const meta = lastSyncLogUpdate?.metadata
    expect(meta == null).toBe(true)
  })

  it('persists feed_errors and status=partial when some feeds fail (#132)', async () => {
    // First feed (thezvi) fails; rest succeed via the default empty-items mock.
    mockFetchFeed.mockRejectedValueOnce(new Error('Network error'))

    await GET(createRequest(MOCK_SECRET))

    expect(lastSyncLogUpdate).not.toBeNull()
    expect(lastSyncLogUpdate).toMatchObject({
      status: 'partial',
      feed_errors: 1,
    })
    const meta = lastSyncLogUpdate?.metadata as { feedErrors: { url: string; reason: string }[] }
    expect(meta).toBeTruthy()
    expect(meta.feedErrors).toHaveLength(1)
    expect(meta.feedErrors[0].url).toBe(TEST_FEEDS[0].url)
    expect(meta.feedErrors[0].reason).toContain('Network error')
  })

  it('persists status=error when every feed fails (#132)', async () => {
    // Override the beforeEach default to reject on every call.
    mockFetchFeed.mockReset()
    mockFetchFeed.mockRejectedValue(new Error('Total outage'))

    await GET(createRequest(MOCK_SECRET))

    expect(lastSyncLogUpdate).not.toBeNull()
    expect(lastSyncLogUpdate).toMatchObject({
      status: 'error',
      feed_errors: TEST_FEEDS.length,
    })
    const meta = lastSyncLogUpdate?.metadata as { feedErrors: { url: string; reason: string }[] }
    expect(meta).toBeTruthy()
    expect(meta.feedErrors).toHaveLength(TEST_FEEDS.length)
    // Every failed entry carries one of the configured feed URLs.
    const configured = new Set(TEST_FEEDS.map((f) => f.url))
    for (const fe of meta.feedErrors) {
      expect(configured.has(fe.url)).toBe(true)
      expect(fe.reason).toContain('Total outage')
    }
    // Critical invariant: on the all-failure path no feed is recorded as
    // healthy, and every feed records exactly one error.
    expect(mockRecordSuccess).not.toHaveBeenCalled()
    expect(mockRecordError).toHaveBeenCalledTimes(TEST_FEEDS.length)
  })

  it('captures Supabase-shaped errors in the outer catch with full detail (#132 follow-up)', async () => {
    // Real-world repro from manual Spotify sync test: supabase-js threw a
    // PostgrestError with { message, code, hint, details } — a plain object,
    // not an Error instance. Pre-fix this serialized as "Unknown error" in
    // sync_logs.error_message; the diagnostic ("HTTP headers exceeded server
    // limits") was lost.
    const supabaseError = {
      message: 'TypeError: fetch failed',
      details: 'TypeError: fetch failed\n\nCaused by: HeadersOverflowError',
      hint: 'HTTP headers exceeded server limits (typically 16KB).',
      code: '',
    }

    let lastErrorUpdate: Record<string, unknown> | null = null
    let updateCalls = 0
    mockFrom.mockImplementation((table: string) => {
      if (table === 'sync_logs') {
        return {
          insert: () => ({
            select: () => ({
              single: () => Promise.resolve({ data: { id: 1 }, error: null }),
            }),
          }),
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: () => Promise.resolve({ data: null, error: null }),
                  }),
                }),
              }),
            }),
          }),
          update: (payload: Record<string, unknown>) => {
            updateCalls++
            if (updateCalls === 1) {
              // Success-path update — reject (not return) with a Supabase-shaped
              // error so the outer catch fires with syncLogId already set.
              return { eq: () => Promise.reject(supabaseError) }
            }
            // Outer-catch error update — capture for assertion.
            lastErrorUpdate = payload
            return { eq: () => Promise.resolve({ error: null }) }
          },
        }
      }
      return createDeepChain({ data: { id: 1, completed_at: null }, error: null })
    })

    const response = await GET(createRequest(MOCK_SECRET))
    expect(response.status).toBe(500)

    expect(lastErrorUpdate).not.toBeNull()
    expect(lastErrorUpdate).toMatchObject({
      status: 'error',
      error_message: 'TypeError: fetch failed',
    })
    const meta = lastErrorUpdate?.metadata as {
      error: { hint?: string; details?: string }
    }
    expect(meta).toBeTruthy()
    expect(meta.error.hint).toContain('HTTP headers exceeded')
    expect(meta.error.details).toContain('HeadersOverflowError')
  })

  it('signals success: false when the sync_logs update fails (#132)', async () => {
    // The whole point of #132 is that the DB row is the source of truth for
    // sync health. If the finalizing update silently fails (schema cache
    // stale, transient DB error, etc.), the row stays in 'running' with no
    // feed_errors / metadata — and the cron worker today sees HTTP 200,
    // success: true. That defeats the change. Surface it instead.
    setupSyncLogsMock({ updateError: { message: 'simulated DB write failure' } })

    const response = await GET(createRequest(MOCK_SECRET))
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body.success).toBe(false)
    expect(typeof body.syncLogError).toBe('string')
    expect(body.syncLogError).toContain('simulated DB write failure')
  })

  describe('item-level failures (RLV-014)', () => {
    beforeEach(() => {
      // Single feed so per-feed bookkeeping is unambiguous.
      mockListFeeds.mockResolvedValue([TEST_FEEDS[0]])
      mockFetchFeed.mockReset()
      mockFetchFeed.mockResolvedValue({
        items: [{
          title: 'Doomed Post',
          link: 'https://thezvi.substack.com/p/doomed',
          isoDate: '2026-03-30T12:00:00.000Z',
        }],
      })
      // Unmatched → create path, which is what throws.
      mockFindMatchingContent.mockResolvedValue(null)
    })

    it('counts a failed createContent as errors, not skipped', async () => {
      mockCreateContent.mockRejectedValueOnce(new Error('RPC: Link is required'))

      const body = await (await GET(createRequest(MOCK_SECRET))).json()

      expect(body.errors).toBe(1)
      expect(body.created).toBe(0)
      // A genuine failure must not masquerade as a dedup skip.
      expect(body.skipped).toBe(0)
    })

    it('marks the run partial (not success) so sync health reflects the failure', async () => {
      mockCreateContent.mockRejectedValueOnce(new Error('RPC: Link is required'))

      await GET(createRequest(MOCK_SECRET))

      // recordFeedError (not recordFeedSuccess) holds the feed's cutoff so the
      // failed item is retried next run instead of filtered forever.
      expect(lastSyncLogUpdate).toMatchObject({ status: 'partial' })
    })

    it('does not record the feed as successful when an item failed (preserves first-poll window)', async () => {
      mockCreateContent.mockRejectedValueOnce(new Error('RPC: Link is required'))

      await GET(createRequest(MOCK_SECRET))

      // recordFeedSuccess sets last_success_at, consuming the first-poll backfill
      // window. Skipping it keeps the feed eligible to re-ingest the failed item.
      expect(mockRecordSuccess).not.toHaveBeenCalled()
      expect(mockRecordError).toHaveBeenCalledWith(TEST_FEEDS[0].id, expect.stringContaining('item'))
    })

    it('records the feed error (not success) even when some items in it persist', async () => {
      // Two items in the one feed: the first creates fine, the second throws.
      // The feed still must not record success — one lost write is enough to
      // keep it first-poll-eligible and hold the run at partial.
      mockFetchFeed.mockReset()
      mockFetchFeed.mockResolvedValue({
        items: [
          { title: 'Good Post', link: 'https://thezvi.substack.com/p/good', isoDate: '2026-03-30T12:00:00.000Z' },
          { title: 'Doomed Post', link: 'https://thezvi.substack.com/p/doomed', isoDate: '2026-03-30T12:00:00.000Z' },
        ],
      })
      mockCreateContent
        .mockResolvedValueOnce({ contentItemId: 1 })
        .mockRejectedValueOnce(new Error('RPC: Link is required'))

      const body = await (await GET(createRequest(MOCK_SECRET))).json()

      expect(body.created).toBe(1)
      expect(body.errors).toBe(1)
      expect(mockRecordSuccess).not.toHaveBeenCalled()
      expect(mockRecordError).toHaveBeenCalledWith(TEST_FEEDS[0].id, expect.stringContaining('item'))
      expect(lastSyncLogUpdate).toMatchObject({ status: 'partial', metadata: { itemErrors: 1 } })
    })

    it('still records success and status=success when every item persists', async () => {
      // Default mockCreateContent resolves — the healthy path is unchanged.
      const body = await (await GET(createRequest(MOCK_SECRET))).json()

      expect(body.errors).toBe(0)
      expect(body.created).toBe(1)
      expect(lastSyncLogUpdate).toMatchObject({ status: 'success' })
      expect(mockRecordSuccess).toHaveBeenCalledWith(TEST_FEEDS[0].id, expect.any(Number))
    })
  })

  describe('first-poll backfill (#164)', () => {
    // Never-polled feed (last_success_at NULL) with backfill OPTED IN (90 days).
    const backfillFeed = { ...TEST_FEEDS[0], lastSuccessAt: null, backfillDays: 90 }
    // Never-polled feed with backfill OFF (the default).
    const offFeed = { ...TEST_FEEDS[0], lastSuccessAt: null, backfillDays: null }

    it('ingests back-catalog items within the opted-in window on first poll', async () => {
      mockListFeeds.mockResolvedValue([backfillFeed])
      mockFetchFeed.mockResolvedValueOnce({
        items: [{ title: 'Back Catalog Post', link: 'https://thezvi.substack.com/p/back-catalog', isoDate: daysAgo(60) }],
      })

      const body = await (await GET(createRequest(MOCK_SECRET))).json()
      expect(body.created).toBe(1)
      expect(mockCreateContent).toHaveBeenCalledTimes(1)
    })

    it('honors a smaller window (30 days excludes a 60-day-old item)', async () => {
      mockListFeeds.mockResolvedValue([{ ...backfillFeed, backfillDays: 30 }])
      mockFetchFeed.mockResolvedValueOnce({
        items: [{ title: 'Old Post', link: 'https://thezvi.substack.com/p/old', isoDate: daysAgo(60) }],
      })

      const body = await (await GET(createRequest(MOCK_SECRET))).json()
      expect(body.created).toBe(0)
      expect(mockFindMatchingContent).not.toHaveBeenCalled()
    })

    it('includes date-only items published exactly N days ago (boundary)', async () => {
      // publishedOn is date-only (midnight UTC) while the cutoff carries
      // wall-clock time — the +1-day buffer keeps the window's oldest day.
      mockListFeeds.mockResolvedValue([backfillFeed])
      mockFetchFeed.mockResolvedValueOnce({
        items: [{ title: 'Boundary Post', link: 'https://thezvi.substack.com/p/boundary', isoDate: daysAgo(90) }],
      })

      const body = await (await GET(createRequest(MOCK_SECRET))).json()
      expect(body.created).toBe(1)
    })

    it('with backfill OFF, a never-polled feed uses a 0-day window (no back catalog)', async () => {
      mockListFeeds.mockResolvedValue([offFeed])
      mockFetchFeed.mockResolvedValueOnce({
        items: [{ title: '8-Day-Old Post', link: 'https://thezvi.substack.com/p/recent-ish', isoDate: daysAgo(8) }],
      })

      const body = await (await GET(createRequest(MOCK_SECRET))).json()
      expect(body.created).toBe(0)
      expect(mockFindMatchingContent).not.toHaveBeenCalled()
    })

    it('with backfill OFF and NO prior sync, does NOT ingest the whole back catalog', async () => {
      // The critical Codex finding: no code path may leak the back catalog.
      // First poll always gets a bounded (0-day + buffer) window.
      mockListFeeds.mockResolvedValue([offFeed])
      mockFetchFeed.mockResolvedValueOnce({
        items: [{ title: 'Old Post', link: 'https://thezvi.substack.com/p/old', isoDate: daysAgo(10) }],
      })

      const body = await (await GET(createRequest(MOCK_SECRET))).json()
      expect(body.created).toBe(0)
      expect(mockFindMatchingContent).not.toHaveBeenCalled()
    })

    it('flips to the last_success_at cutoff once the feed has a successful poll', async () => {
      mockListFeeds.mockResolvedValue([{ ...TEST_FEEDS[0], lastSuccessAt: daysAgo(1), backfillDays: 90 }])
      mockFetchFeed.mockResolvedValueOnce({
        items: [{ title: 'Back Catalog Post', link: 'https://thezvi.substack.com/p/back-catalog', isoDate: daysAgo(60) }],
      })

      const body = await (await GET(createRequest(MOCK_SECRET))).json()
      expect(body.created).toBe(0)
      expect(mockFindMatchingContent).not.toHaveBeenCalled()
    })

    it('still includes undated items on first poll when backfill is opted in', async () => {
      mockListFeeds.mockResolvedValue([backfillFeed])
      mockFetchFeed.mockResolvedValueOnce({
        items: [{ title: 'Undated Post', link: 'https://thezvi.substack.com/p/undated' }],
      })

      const body = await (await GET(createRequest(MOCK_SECRET))).json()
      expect(body.created).toBe(1)
    })

    it('excludes undated items on a first-poll feed when backfill is OFF', async () => {
      // Undated items are indistinguishable from old back catalog, so "off"
      // must not ingest them. They arrive next cycle once the feed is in
      // steady state (undated items are included there). (#164 review)
      mockListFeeds.mockResolvedValue([offFeed])
      mockFetchFeed.mockResolvedValueOnce({
        items: [{ title: 'Undated Post', link: 'https://thezvi.substack.com/p/undated' }],
      })

      const body = await (await GET(createRequest(MOCK_SECRET))).json()
      expect(body.created).toBe(0)
      expect(mockFindMatchingContent).not.toHaveBeenCalled()
    })

    it('still includes undated items in steady state (last_success_at set)', async () => {
      // Regression guard: the undated exclusion is scoped to first-poll-off only.
      mockListFeeds.mockResolvedValue([{ ...TEST_FEEDS[0], lastSuccessAt: daysAgo(1), backfillDays: null }])
      mockFetchFeed.mockResolvedValueOnce({
        items: [{ title: 'Undated Post', link: 'https://thezvi.substack.com/p/undated' }],
      })

      const body = await (await GET(createRequest(MOCK_SECRET))).json()
      expect(body.created).toBe(1)
    })

    it('created items still flow through the matching cascade (dedup unchanged)', async () => {
      mockListFeeds.mockResolvedValue([backfillFeed])
      mockFetchFeed.mockResolvedValueOnce({
        items: [{ title: 'Already Ingested Post', link: 'https://thezvi.substack.com/p/already-ingested', isoDate: daysAgo(60) }],
      })
      mockFindMatchingContent.mockResolvedValue({ contentItemId: 7, action: 'update' })

      const body = await (await GET(createRequest(MOCK_SECRET))).json()
      expect(body.created).toBe(0)
      expect(body.skipped).toBe(1)
      expect(mockCreateContent).not.toHaveBeenCalled()
    })
  })

  describe('fail-closed cutoff (#287)', () => {
    const post = (i: number, iso: string) => ({
      title: `Post ${i}`,
      link: `https://thezvi.substack.com/p/post-${i}`,
      isoDate: iso,
    })

    it('never reads sync_logs to derive the cutoff; ingests only past the feed boundary', async () => {
      // 2026-09-12 incident: a transient gateway error on a sync_logs lookup
      // was treated as "no previous sync" → null cutoff → the whole back
      // catalog ingested. The steady-state cutoff now comes from the feed's
      // own last_success_at; setupSyncLogsMock() throws on any sync_logs read.
      mockListFeeds.mockResolvedValue([{ ...TEST_FEEDS[0], lastSuccessAt: daysAgo(3) }])
      mockFetchFeed.mockResolvedValue({
        items: [post(1, daysAgo(400)), post(2, daysAgo(1))],
      })

      const response = await GET(createRequest(MOCK_SECRET))
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body.created).toBe(1)
      expect(mockCreateContent).toHaveBeenCalledTimes(1)
      expect(mockCreateContent.mock.calls[0][0]).toMatchObject({ title: 'Post 2' })
    })

    it('uses the feed\'s own last_success_at as the steady-state cutoff, not a global one', async () => {
      // A newer global success (another feed's run) must not hide items this
      // feed missed while it was failing — the per-feed boundary is the truth.
      mockListFeeds.mockResolvedValue([{ ...TEST_FEEDS[0], lastSuccessAt: daysAgo(10) }])
      mockFetchFeed.mockResolvedValueOnce({
        items: [post(1, daysAgo(30)), post(2, daysAgo(5))],
      })

      const body = await (await GET(createRequest(MOCK_SECRET))).json()

      expect(body.created).toBe(1)
      expect(mockCreateContent.mock.calls[0][0]).toMatchObject({ title: 'Post 2' })
    })

    it('skips a steady-state feed that yields more than 100 new items and marks the run partial', async () => {
      // Feed 1 trips the guard; feed 2 is healthy, so the run is partial.
      mockListFeeds.mockResolvedValue([
        { ...TEST_FEEDS[0], lastSuccessAt: daysAgo(3) },
        { ...TEST_FEEDS[1], lastSuccessAt: daysAgo(3) },
      ])
      mockFetchFeed
        .mockResolvedValueOnce({ items: Array.from({ length: 101 }, (_, i) => post(i, daysAgo(1))) })
        .mockResolvedValueOnce({ items: [] })

      const body = await (await GET(createRequest(MOCK_SECRET))).json()

      expect(body.created).toBe(0)
      expect(mockCreateContent).not.toHaveBeenCalled()
      expect(body.status).toBe('partial')
      expect(body.feedErrors).toBe(1)
      // The skip advances the feed's cutoff (advanceCutoff) so the same items
      // don't re-trip the guard every run — the alert fires once, and the
      // backfill tool recovers the items if they were legitimate.
      expect(mockRecordError).toHaveBeenCalledWith(
        TEST_FEEDS[0].id,
        expect.stringContaining('101'),
        { advanceCutoff: true }
      )
      expect(mockRecordSuccess).toHaveBeenCalledTimes(1)
      expect(mockRecordSuccess).toHaveBeenCalledWith(TEST_FEEDS[1].id, 0)
      const meta = lastSyncLogUpdate?.metadata as {
        feedErrors: { url: string; reason: string; kind: string }[]
      }
      expect(meta.feedErrors[0]).toMatchObject({ url: TEST_FEEDS[0].url, kind: 'guard' })
      // A guard trip is always an anomaly: it must reach the log service
      // even though the run is only 'partial'.
      expect(mockLogError).toHaveBeenCalledWith(
        'rss-sync',
        expect.stringContaining('sanity bound'),
        expect.objectContaining({ feedErrors: meta.feedErrors })
      )
    })

    it('marks the run status=error when every feed fails, by fetch or guard', async () => {
      // Nothing was ingested from any feed — the worst case must not read as
      // a milder 'partial' on /settings/status.
      mockListFeeds.mockResolvedValue([
        { ...TEST_FEEDS[0], lastSuccessAt: daysAgo(3) },
        { ...TEST_FEEDS[1], lastSuccessAt: daysAgo(3) },
      ])
      mockFetchFeed
        .mockResolvedValueOnce({ items: Array.from({ length: 101 }, (_, i) => post(i, daysAgo(1))) })
        .mockRejectedValueOnce(new Error('fetch failed'))

      const body = await (await GET(createRequest(MOCK_SECRET))).json()

      expect(body.status).toBe('error')
      expect(lastSyncLogUpdate).toMatchObject({ status: 'error', feed_errors: 2 })
      expect(mockLogError).toHaveBeenCalledWith(
        'rss-sync',
        expect.stringContaining('all 2 feeds failed'),
        expect.anything()
      )
      // One alert for the run, not one per condition.
      expect(mockLogError).toHaveBeenCalledTimes(1)
    })

    it('does not cap a never-polled feed inside its opted-in backfill window', async () => {
      mockListFeeds.mockResolvedValue([{ ...TEST_FEEDS[0], lastSuccessAt: null, backfillDays: 365 }])
      mockFetchFeed.mockResolvedValueOnce({
        items: Array.from({ length: 120 }, (_, i) => post(i, daysAgo(10))),
      })

      const body = await (await GET(createRequest(MOCK_SECRET))).json()

      expect(body.created).toBe(120)
      expect(body.status).toBe('success')
    })
  })

  describe('log service (#269)', () => {
    it('reports an all-feeds-failed run (status=error) to the log service', async () => {
      // Same setup as "persists status=error when every feed fails (#132)".
      mockFetchFeed.mockReset()
      mockFetchFeed.mockRejectedValue(new Error('Total outage'))

      await GET(createRequest(MOCK_SECRET))

      expect(mockLogError).toHaveBeenCalledWith(
        'rss-sync',
        expect.stringContaining('feed'),
        expect.objectContaining({ feedErrors: expect.any(Array) }),
      )
    })

    it('reports an unhandled outer-catch error to the log service', async () => {
      // Same setup as "captures Supabase-shaped errors in the outer catch
      // with full detail (#132 follow-up)".
      const supabaseError = {
        message: 'TypeError: fetch failed',
        details: 'TypeError: fetch failed\n\nCaused by: HeadersOverflowError',
        hint: 'HTTP headers exceeded server limits (typically 16KB).',
        code: '',
      }

      let updateCalls = 0
      mockFrom.mockImplementation((table: string) => {
        if (table === 'sync_logs') {
          return {
            insert: () => ({
              select: () => ({
                single: () => Promise.resolve({ data: { id: 1 }, error: null }),
              }),
            }),
            select: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () => ({
                      maybeSingle: () => Promise.resolve({ data: null, error: null }),
                    }),
                  }),
                }),
              }),
            }),
            update: () => {
              updateCalls++
              if (updateCalls === 1) {
                return { eq: () => Promise.reject(supabaseError) }
              }
              return { eq: () => Promise.resolve({ error: null }) }
            },
          }
        }
        return createDeepChain({ data: { id: 1, completed_at: null }, error: null })
      })

      const response = await GET(createRequest(MOCK_SECRET))
      expect(response.status).toBe(500)

      expect(mockLogError).toHaveBeenCalledWith('rss-sync', expect.anything(), expect.anything())
    })

    it('reports a sync_logs update failure to the log service', async () => {
      // Same setup as "signals success: false when the sync_logs update fails (#132)".
      setupSyncLogsMock({ updateError: { message: 'simulated DB write failure' } })

      await GET(createRequest(MOCK_SECRET))

      expect(mockLogError).toHaveBeenCalledWith(
        'rss-sync',
        expect.anything(),
        expect.objectContaining({ blindSpot: 'sync_logs-write' }),
      )
    })

    it('reports a sync_logs insert failure to the log service', async () => {
      // The initial sync_logs INSERT fails outright — syncLogId stays null,
      // so the run falls into the `else` branch ("insert failed earlier; the
      // work ran but no row exists to mark") instead of the update-failure
      // branch above.
      mockFrom.mockImplementation((table: string) => {
        if (table === 'sync_logs') {
          return {
            insert: () => ({
              select: () => ({
                single: () => Promise.resolve({ data: null, error: { message: 'insert failed' } }),
              }),
            }),
            select: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () => ({
                      maybeSingle: () => Promise.resolve({ data: null, error: null }),
                    }),
                  }),
                }),
              }),
            }),
            update: () => ({ eq: () => Promise.resolve({ error: null }) }),
          }
        }
        return createDeepChain({ data: { id: 1, completed_at: null }, error: null })
      })

      await GET(createRequest(MOCK_SECRET))

      expect(mockLogError).toHaveBeenCalledWith(
        'rss-sync',
        expect.anything(),
        expect.objectContaining({ blindSpot: 'sync_logs-write' }),
      )
    })

    it('does not log on a healthy run', async () => {
      // Same setup as "persists feed_errors=0 and status=success (#132)".
      await GET(createRequest(MOCK_SECRET))

      expect(mockLogError).not.toHaveBeenCalled()
    })
  })
})
