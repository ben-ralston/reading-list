import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { POST } from './route'

// Mock environment variable
const MOCK_SECRET = 'test-secret-123'

// Mock Supabase client
const mockFrom = vi.fn()
const mockRpc = vi.fn()

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}))

// Mock next/server's after() — throws "outside request scope" in test env
vi.mock('next/server', async () => {
  const actual = await vi.importActual('next/server')
  return { ...actual, after: vi.fn() }
})

// Mock summary generation (called via after() in the route)
vi.mock('@/lib/summary', () => ({
  generateSummary: vi.fn().mockResolvedValue({ summary: 'test', generatedAt: '' }),
}))

const mockLogError = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/logger', () => ({
  logError: (...a: unknown[]) => mockLogError(...a),
}))

// Helper to create mock Request
function createRequest(body: unknown): Request {
  return new Request('http://localhost/api/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// Helper to chain Supabase-style query methods
function createMockChain(finalResult: { data?: unknown; error?: unknown }) {
  const chain: any = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    ilike: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(finalResult),
    single: vi.fn().mockResolvedValue(finalResult),
  }

  // Override update() to return a chain that supports .eq().eq() for updateSourceProgress,
  // but also .eq().not() for updateContentProgress
  const updateChain: any = {
    eq: vi.fn(),
    not: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(finalResult),
    single: vi.fn().mockResolvedValue(finalResult),
  }

  // The first .eq() returns another chain that supports another .eq()
  updateChain.eq = vi.fn().mockReturnValue({
    eq: vi.fn().mockResolvedValue({ error: null }),
    not: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(finalResult),
    single: vi.fn().mockResolvedValue(finalResult),
  })

  chain.update = vi.fn().mockReturnValue(updateChain)

  return chain
}

describe('POST /api/sync', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockRpc.mockResolvedValue({ data: null, error: null })
    mockLogError.mockClear()
    process.env.SYNC_API_SECRET = MOCK_SECRET
  })

  afterEach(() => {
    delete process.env.SYNC_API_SECRET
  })

  describe('authentication', () => {
    it('should reject requests with missing secret', async () => {
      const request = createRequest({
        source: 'spotify',
        items: [],
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(401)
      expect(data.error).toBe('Invalid or missing secret')
    })

    it('should reject requests with invalid secret', async () => {
      const request = createRequest({
        source: 'spotify',
        secret: 'wrong-secret',
        items: [],
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(401)
      expect(data.error).toBe('Invalid or missing secret')
    })

    // #281 F13: nothing an unauthenticated caller sends may reach the external
    // logger (its rows can raise alerts).
    it('returns 400 for malformed JSON without calling logError', async () => {
      const request = new Request('http://localhost/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      })

      const response = await POST(request)

      expect(response.status).toBe(400)
      expect(mockLogError).not.toHaveBeenCalled()
    })

    it('returns 401 for a non-string secret without calling logError', async () => {
      for (const secret of [12345, { toString: 'x' }, ['a', 'b']]) {
        const response = await POST(createRequest({ source: 'spotify', secret, items: [] }))
        expect(response.status).toBe(401)
      }
      expect(mockLogError).not.toHaveBeenCalled()
    })

    it('returns 400 for a non-object body without calling logError', async () => {
      const response = await POST(createRequest(null))
      expect(response.status).toBe(400)
      expect(mockLogError).not.toHaveBeenCalled()
    })

    it('should accept requests with valid secret', async () => {
      // Setup mocks for sync_logs insert
      const logChain = createMockChain({ data: { id: 1 }, error: null })
      mockFrom.mockImplementation((table: string) => {
        if (table === 'sync_logs') return logChain
        return createMockChain({ data: null, error: null })
      })

      const request = createRequest({
        source: 'spotify',
        secret: MOCK_SECRET,
        items: [],
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.success).toBe(true)
    })

    it('should return 500 if SYNC_API_SECRET is not configured', async () => {
      delete process.env.SYNC_API_SECRET

      const request = createRequest({
        source: 'spotify',
        secret: 'any-secret',
        items: [],
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(500)
      expect(data.error).toBe('Server configuration error')
    })
  })

  describe('validation', () => {
    it('should reject invalid source', async () => {
      const request = createRequest({
        source: 'invalid-source',
        secret: MOCK_SECRET,
        items: [],
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toContain('Invalid source')
    })

    it('should accept valid sources', async () => {
      const validSources = ['spotify', 'audible', 'substack', 'elevenreader', 'tasklet']

      for (const source of validSources) {
        const logChain = createMockChain({ data: { id: 1 }, error: null })
        mockFrom.mockImplementation((table: string) => {
          if (table === 'sync_logs') return logChain
          return createMockChain({ data: null, error: null })
        })

        const request = createRequest({
          source,
          secret: MOCK_SECRET,
          items: [],
        })

        const response = await POST(request)
        expect(response.status).toBe(200)
      }
    })

    it('should reject non-array items', async () => {
      const request = createRequest({
        source: 'spotify',
        secret: MOCK_SECRET,
        items: 'not-an-array',
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Items must be an array')
    })
  })

  describe('matching and processing', () => {
    it('should skip items with missing title or author', async () => {
      const logChain = createMockChain({ data: { id: 1 }, error: null })
      mockFrom.mockImplementation((table: string) => {
        if (table === 'sync_logs') return logChain
        return createMockChain({ data: null, error: null })
      })

      const request = createRequest({
        source: 'spotify',
        secret: MOCK_SECRET,
        items: [
          { title: '', author: 'Author' },
          { title: 'Title', author: '' },
          { author: 'Only Author' },
          { title: 'Only Title' },
        ],
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.skipped).toBe(4)
      expect(data.processed).toBe(0)
    })

    it('should update existing content when matched by external_id', async () => {
      const logChain = createMockChain({ data: { id: 1 }, error: null })
      const sourceChain = createMockChain({
        data: { id: 100, content_item_id: 50 },
        error: null,
      })
      const updateChain = createMockChain({ data: null, error: null })

      mockFrom.mockImplementation((table: string) => {
        if (table === 'sync_logs') return logChain
        if (table === 'content_sources') return sourceChain
        if (table === 'content_items') return updateChain
        return createMockChain({ data: null, error: null })
      })

      const request = createRequest({
        source: 'spotify',
        secret: MOCK_SECRET,
        items: [
          {
            title: 'Podcast Episode',
            author: 'Host Name',
            externalId: 'spotify:episode:abc123',
            progress: '65',
            status: 'In Progress',
          },
        ],
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.updated).toBe(1)
      expect(mockRpc).toHaveBeenCalledWith('apply_spotify_progress', {
        updates: [{ id: 50, progress: '65', status: 'In Progress', source: 'spotify' }],
      })
      expect(data.processed).toBe(1)
    })

    it('should match via author alias when exact title+author fails', async () => {
      const logChain = createMockChain({ data: { id: 1 }, error: null })
      // Strategy 1: No match by external_id
      const sourceChain = createMockChain({ data: null, error: null })

      // Track content_items ilike calls to differentiate Strategy 2 vs Strategy 3.
      // The matching layer is kind-scoped, so the chain is now
      // .select('id, title, author').eq('kind', 'feed').ilike('author', …).
      let authorQueryCount = 0
      const ilikeImpl = vi.fn().mockImplementation((_field: string, authorValue: string) => {
        authorQueryCount++
        if (authorValue.toLowerCase() === 'redwood research blog') {
          return Promise.resolve({ data: [], error: null })
        }
        return Promise.resolve({
          data: [{ id: 50, title: 'The inaugural Redwood Research podcast', author: 'Redwood Research' }],
          error: null,
        })
      })
      const contentChain = {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({ ilike: ilikeImpl }),
        }),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null }),
        }),
      }

      mockFrom.mockImplementation((table: string) => {
        if (table === 'sync_logs') return logChain
        if (table === 'content_sources') return sourceChain
        if (table === 'content_items') return contentChain
        return createMockChain({ data: null, error: null })
      })

      // get_author_aliases returns alias group for Redwood Research
      mockRpc.mockImplementation((funcName: string) => {
        if (funcName === 'get_author_aliases') {
          return Promise.resolve({
            data: ['redwood research', 'redwood research blog'],
            error: null,
          })
        }
        return Promise.resolve({ data: null, error: null })
      })

      const request = createRequest({
        source: 'spotify',
        secret: MOCK_SECRET,
        items: [
          {
            title: 'The inaugural Redwood Research podcast',
            author: 'Redwood Research Blog',
            externalId: 'spotify:episode:stale123',
            progress: '100',
            status: 'Completed',
          },
        ],
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.updated).toBe(1)
      expect(data.created).toBe(0)
      // Verify alias lookup was used
      expect(mockRpc).toHaveBeenCalledWith('get_author_aliases', {
        p_author: 'Redwood Research Blog',
      })
    })

    it('should auto-create unmatched Spotify items', async () => {
      const logChain = createMockChain({ data: { id: 1 }, error: null })
      const sourceChain = createMockChain({ data: null, error: null }) // No match by external_id

      const contentChain = {
        select: vi.fn().mockReturnValue({
          // insertAtSmartPosition now chains .eq('kind', kind) before .not/.gte (#147).
          eq: vi.fn().mockReturnThis(),
          ilike: vi.fn().mockResolvedValue({ data: [], error: null }),
          not: vi.fn().mockResolvedValue({ count: 0, error: null }),
          gte: vi.fn().mockReturnValue({
            neq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
          or: vi.fn().mockResolvedValue({ data: [], error: null }),
        }),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null }),
        }),
      }
      const engagementChain = {
        select: vi.fn().mockResolvedValue({ data: [], error: null }),
      }

      mockFrom.mockImplementation((table: string) => {
        if (table === 'sync_logs') return logChain
        if (table === 'content_sources') return sourceChain
        if (table === 'content_items') return contentChain
        if (table === 'author_engagement_scores') return engagementChain
        return createMockChain({ data: null, error: null })
      })

      mockRpc.mockImplementation((funcName: string) => {
        if (funcName === 'upsert_content_item') return Promise.resolve({ data: [{ content_id: 999, inserted: true }], error: null })
        if (funcName === 'get_author_aliases') return Promise.resolve({ data: [], error: null })
        if (funcName === 'batch_update_content_items') return Promise.resolve({ error: null })
        return Promise.resolve({ data: null, error: null })
      })

      const request = createRequest({
        source: 'spotify',
        secret: MOCK_SECRET,
        items: [
          {
            title: 'Unknown Podcast',
            author: 'Unknown Host',
            externalId: 'spotify:episode:unknown',
          },
        ],
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.created).toBe(1)
      expect(data.skipped).toBe(0)
      expect(mockRpc).toHaveBeenCalledWith('upsert_content_item', expect.any(Object))
    })

    it('should auto-create unmatched items for non-Spotify sources', async () => {
      const logChain = createMockChain({ data: { id: 1 }, error: null })
      const sourceChain = createMockChain({ data: null, error: null }) // No match

      // Content items chain needs to support multiple query patterns:
      // 1. findMatchingContent: .select().ilike('author', ...) returns list
      // 2. fetchAuthorItems (scoring): .select().or()
      // 3. insertAtSmartPosition count: .select().not() → { count }
      // 4. insertAtSmartPosition shift: .select().gte().neq().order()
      // 5. insertAtSmartPosition update: .update().eq()
      const contentChain = {
        select: vi.fn().mockReturnValue({
          // insertAtSmartPosition now chains .eq('kind', kind) before .not/.gte (#147).
          eq: vi.fn().mockReturnThis(),
          ilike: vi.fn().mockResolvedValue({ data: [], error: null }),
          not: vi.fn().mockResolvedValue({ count: 0, error: null }),
          gte: vi.fn().mockReturnValue({
            neq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
          or: vi.fn().mockResolvedValue({ data: [], error: null }),
        }),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null }),
        }),
      }
      const engagementChain = {
        select: vi.fn().mockResolvedValue({ data: [], error: null }),
      }

      mockFrom.mockImplementation((table: string) => {
        if (table === 'sync_logs') return logChain
        if (table === 'content_sources') return sourceChain
        if (table === 'content_items') return contentChain
        if (table === 'author_engagement_scores') return engagementChain
        return createMockChain({ data: null, error: null })
      })

      // Handle multiple RPC calls
      mockRpc.mockImplementation((funcName: string) => {
        if (funcName === 'upsert_content_item') return Promise.resolve({ data: [{ content_id: 999, inserted: true }], error: null })
        if (funcName === 'get_author_aliases') return Promise.resolve({ data: [], error: null })
        if (funcName === 'batch_update_content_items') return Promise.resolve({ error: null })
        return Promise.resolve({ data: null, error: null })
      })

      const request = createRequest({
        source: 'audible',
        secret: MOCK_SECRET,
        items: [
          {
            title: 'New Audiobook',
            author: 'New Author',
            externalId: 'audible:book:B08XXXX',
            progress: '25',
          },
        ],
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.created).toBe(1)
      expect(mockRpc).toHaveBeenCalledWith('upsert_content_item', expect.any(Object))
    })

    it('should skip (not create) unmatched substack items — progress harvest is update-only (#192)', async () => {
      const logChain = createMockChain({ data: { id: 1 }, error: null })
      const sourceChain = createMockChain({ data: null, error: null }) // Strategy 1 & 4 miss
      const contentChain = {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            ilike: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        }),
      }

      mockFrom.mockImplementation((table: string) => {
        if (table === 'sync_logs') return logChain
        if (table === 'content_sources') return sourceChain
        if (table === 'content_items') return contentChain
        return createMockChain({ data: null, error: null })
      })

      mockRpc.mockImplementation((funcName: string) => {
        if (funcName === 'get_author_aliases') return Promise.resolve({ data: [], error: null })
        return Promise.resolve({ data: null, error: null })
      })

      const request = createRequest({
        source: 'substack',
        secret: MOCK_SECRET,
        items: [
          {
            title: 'A Post The Queue Has Never Seen',
            author: 'Some Publication',
            platform: 'Substack',
            link: 'https://somepub.substack.com/p/never-seen',
            externalId: 'substack:post:123456',
            progress: '42',
            status: 'In Progress',
          },
        ],
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.created).toBe(0)
      expect(data.skipped).toBe(1)
      expect(data.processed).toBe(1)
      expect(mockRpc).not.toHaveBeenCalledWith('upsert_content_item', expect.any(Object))
    })

    // Audible archived-guard: the daily library sync reports every book's
    // Audible-side state, including books completed or skipped in-app. Unlike
    // substack's read-and-skip, audible keeps its item flow (a finished
    // audiobook must still attach its source to a matched Goodreads book, #42)
    // but the status/progress UPDATE carries the skipArchived predicate so an
    // archived book is never resurrected.
    describe('audible archived-guard', () => {
      it('guards the content update with the not-archived predicate', () => {
        const logChain = createMockChain({ data: { id: 1 }, error: null })
        const sourceChain = createMockChain({
          data: { id: 100, content_item_id: 50 },
          error: null,
        })
        const contentChain = createMockChain({
          data: { status: 'Completed', progress: '100' },
          error: null,
        })

        mockFrom.mockImplementation((table: string) => {
          if (table === 'sync_logs') return logChain
          if (table === 'content_sources') return sourceChain
          if (table === 'content_items') return contentChain
          return createMockChain({ data: null, error: null })
        })
        mockRpc.mockImplementation(() => Promise.resolve({ data: null, error: null }))

        const request = createRequest({
          source: 'audible',
          secret: MOCK_SECRET,
          items: [
            {
              title: 'A Finished Audiobook',
              author: 'Some Author',
              platform: 'Audible',
              link: 'https://audible.com/pd/B0TEST',
              externalId: 'audible:B0TEST',
              progress: '50',
              status: 'In Progress',
              kind: 'book',
            },
          ],
        })

        return POST(request).then(async (response) => {
          expect(response.status).toBe(200)
          expect(mockRpc).toHaveBeenCalledWith('apply_content_progress', {
            p_item_id: 50, p_progress: '50', p_status: 'In Progress', p_skip_archived: true,
          })
        })
      })
    })

    // #192 archived-guard: a passive harvester must never resurrect or churn
    // an archived item (Completed/Skip). Matched substack items whose current
    // status is archived are skipped without any write.
    describe('substack archived-guard (#192)', () => {
      function substackRequest() {
        return createRequest({
          source: 'substack',
          secret: MOCK_SECRET,
          items: [
            {
              title: 'A Matched Post',
              author: 'Some Publication',
              platform: 'Substack',
              link: 'https://somepub.substack.com/p/matched',
              externalId: 'substack:post:196778898',
              progress: '55',
              status: 'In Progress',
            },
          ],
        })
      }

      function setupMatchedItem(currentStatus: string) {
        const logChain = createMockChain({ data: { id: 1 }, error: null })
        // Strategy 1 hit: external_id matches an existing source
        const sourceChain = createMockChain({
          data: { id: 100, content_item_id: 50 },
          error: null,
        })
        // Guard's status read resolves to the item's current status; the same
        // chain would receive updateContentProgress's .update() if called.
        const contentChain = createMockChain({
          data: { status: currentStatus },
          error: null,
        })

        mockFrom.mockImplementation((table: string) => {
          if (table === 'sync_logs') return logChain
          if (table === 'content_sources') return sourceChain
          if (table === 'content_items') return contentChain
          return createMockChain({ data: null, error: null })
        })
        mockRpc.mockImplementation(() => Promise.resolve({ data: null, error: null }))

        return { contentChain, sourceChain }
      }

      it.each(['Completed', 'Skip'])(
        'skips a matched substack item whose current status is %s (no write)',
        async (currentStatus) => {
          const { contentChain } = setupMatchedItem(currentStatus)

          const response = await POST(substackRequest())
          const data = await response.json()

          expect(response.status).toBe(200)
          expect(data.updated).toBe(0)
          expect(data.skipped).toBe(1)
          expect(data.processed).toBe(1)
          expect(contentChain.update).not.toHaveBeenCalled()
        }
      )

      it.each(['', 'In Progress', 'Awaiting comments'])(
        'updates a matched substack item whose current status is %j',
        async (currentStatus) => {
          setupMatchedItem(currentStatus)

          const response = await POST(substackRequest())
          const data = await response.json()

          expect(response.status).toBe(200)
          expect(data.updated).toBe(1)
          expect(data.skipped).toBe(0)
          expect(mockRpc).toHaveBeenCalledWith('apply_content_progress', expect.any(Object))
        }
      )

      function setupMatchedItemWithProgress(currentProgress: string | null) {
        const logChain = createMockChain({ data: { id: 1 }, error: null })
        const sourceChain = createMockChain({
          data: { id: 100, content_item_id: 50 },
          error: null,
        })
        const contentChain = createMockChain({
          data: { status: 'In Progress', progress: currentProgress },
          error: null,
        })

        mockFrom.mockImplementation((table: string) => {
          if (table === 'sync_logs') return logChain
          if (table === 'content_sources') return sourceChain
          if (table === 'content_items') return contentChain
          return createMockChain({ data: null, error: null })
        })
        mockRpc.mockImplementation(() => Promise.resolve({ data: null, error: null }))

        return { contentChain, sourceChain }
      }

      // Progress is a cross-source high-water mark: ~190 prod items carry both
      // a Spotify and a Substack source (AI-voiced podcast of the same post),
      // so the daily harvest must never lower what the listening side raised.
      describe('progress high-water mark', () => {

        // The fixture's incoming progress is '55'
        it.each([
          ['80', false], // lower incoming → progress omitted
          ['55', false], // equal → omitted
          ['20', true], // higher incoming → written
          [null, true], // no stored progress → written
        ])(
          'with current progress %j, writes progress: %s',
          async (currentProgress, expectWrite) => {
            setupMatchedItemWithProgress(currentProgress)

            const response = await POST(substackRequest())
            const data = await response.json()

            expect(response.status).toBe(200)
            expect(data.updated).toBe(1)
            expect(mockRpc).toHaveBeenCalledWith('apply_content_progress', expect.any(Object))
            const written = mockRpc.mock.calls.find(([name]) => name === 'apply_content_progress')![1]
            if (expectWrite) {
              expect(written.p_progress).toBe('55')
            } else {
              expect(written.p_progress).toBeNull()
              // status handling is unchanged — the write is status-only
              expect(written.p_status).toBe('In Progress')
            }
          }
        )
      })

      describe('per-source progress (#194)', () => {
        it('writes the harvested percent onto the source row even when the high-water guard clamps the item write', async () => {
          // Item already at 80 (from listening); incoming Substack report is 55.
          // The item-level write must omit progress (high-water), but the
          // per-source value must still land — "Substack is behind" is exactly
          // what the resume gate needs to see.
          const { sourceChain } = setupMatchedItemWithProgress('80')

          const response = await POST(substackRequest())
          expect(response.status).toBe(200)

          const itemWrite = mockRpc.mock.calls.find(([name]) => name === 'apply_content_progress')![1]
          expect(itemWrite.p_progress).toBeNull()

          const progressWrites = sourceChain.update.mock.calls
            .map((c: unknown[]) => c[0] as Record<string, unknown>)
            .filter((payload: Record<string, unknown>) => 'progress' in payload)
          expect(progressWrites).toEqual([{ progress: 55 }])
        })

        it.each(['Completed', 'Skip'])(
          'archived item (%s): no per-source progress write — the guard continues before any write',
          async (currentStatus) => {
            const { sourceChain } = setupMatchedItem(currentStatus)

            const response = await POST(substackRequest())
            expect(response.status).toBe(200)

            const progressWrites = sourceChain.update.mock.calls
              .map((c: unknown[]) => c[0] as Record<string, unknown>)
              .filter((payload: Record<string, unknown>) => 'progress' in payload)
            expect(progressWrites).toEqual([])
          }
        )
      })

      it('backfills substack:post:<id> onto the matched Substack source (#192)', async () => {
        const logChain = createMockChain({ data: { id: 1 }, error: null })
        const contentChain = createMockChain({ data: { status: 'In Progress' }, error: null })

        // content_sources mock: Strategy-1 lookup (.eq('external_id')…maybeSingle)
        // matches; the backfill lookup (.eq('content_item_id').eq('platform').limit)
        // finds the RSS-created source with external_id NULL.
        // Now also handles updateSourceProgress's .update().eq('content_item_id').eq('platform')
        const sourceUpdateEq = vi.fn().mockImplementation((field: string) => {
          if (field === 'id') {
            // backfill: .update().eq('id', id) → resolves immediately
            return Promise.resolve({ error: null })
          }
          // updateSourceProgress: .update().eq('content_item_id', ...) → returns chain with .eq()
          return { eq: vi.fn().mockResolvedValue({ error: null }) }
        })
        const sourceUpdate = vi.fn().mockReturnValue({ eq: sourceUpdateEq })
        const sourceChain = {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockImplementation((field: string) => {
              if (field === 'external_id') {
                return {
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { id: 100, content_item_id: 50 },
                    error: null,
                  }),
                }
              }
              return {
                eq: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({
                    data: [{ id: 100, external_id: null }],
                    error: null,
                  }),
                }),
              }
            }),
          }),
          update: sourceUpdate,
        }

        mockFrom.mockImplementation((table: string) => {
          if (table === 'sync_logs') return logChain
          if (table === 'content_sources') return sourceChain
          if (table === 'content_items') return contentChain
          return createMockChain({ data: null, error: null })
        })
        mockRpc.mockImplementation(() => Promise.resolve({ data: null, error: null }))

        const response = await POST(substackRequest())
        const data = await response.json()

        expect(response.status).toBe(200)
        expect(data.updated).toBe(1)
        expect(sourceUpdate).toHaveBeenCalledWith({ external_id: 'substack:post:196778898' })
        expect(sourceUpdateEq).toHaveBeenCalledWith('id', 100)
      })
    })
  })

  describe('response format', () => {
    it('should return correct response structure', async () => {
      const logChain = createMockChain({ data: { id: 42 }, error: null })
      mockFrom.mockImplementation((table: string) => {
        if (table === 'sync_logs') return logChain
        return createMockChain({ data: null, error: null })
      })

      const request = createRequest({
        source: 'spotify',
        secret: MOCK_SECRET,
        items: [],
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data).toEqual({
        success: true,
        processed: 0,
        created: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
        syncLogId: 42,
      })
    })
  })

  // RLV-024: per-item exceptions previously folded into `skipped`, so a sync
  // where every write threw still returned 200 {success:true} and marked
  // sync_logs 'success' — /settings/status stayed green while data was lost.
  describe('item-level failures (RLV-024)', () => {
    function failingItemRequest() {
      return createRequest({
        source: 'spotify',
        secret: MOCK_SECRET,
        items: [{ title: 'Doomed', author: 'Author', externalId: 'spotify:episode:x', progress: '10' }],
      })
    }

    // Strategy-1 lookup returns an error → findMatchingContent throws → the item
    // fails inside the per-item try/catch.
    function captureLogUpdate() {
      let payload: Record<string, unknown> | null = null
      const logChain = createMockChain({ data: { id: 1 }, error: null })
      logChain.update = vi.fn().mockImplementation((p: Record<string, unknown>) => {
        payload = p
        return { eq: vi.fn().mockResolvedValue({ error: null }) }
      })
      return { logChain, getPayload: () => payload }
    }

    it('counts a failed item as errors, not skipped, and reports success:false', async () => {
      const logChain = createMockChain({ data: { id: 1 }, error: null })
      const sourceChain = createMockChain({ data: null, error: { message: 'DB down' } })
      mockFrom.mockImplementation((table: string) => {
        if (table === 'sync_logs') return logChain
        if (table === 'content_sources') return sourceChain
        return createMockChain({ data: null, error: null })
      })

      const response = await POST(failingItemRequest())
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.errors).toBe(1)
      expect(data.skipped).toBe(0)
      expect(data.processed).toBe(0)
      expect(data.success).toBe(false)
    })

    it('marks sync_logs status=error when every item fails', async () => {
      const { logChain, getPayload } = captureLogUpdate()
      const sourceChain = createMockChain({ data: null, error: { message: 'DB down' } })
      mockFrom.mockImplementation((table: string) => {
        if (table === 'sync_logs') return logChain
        if (table === 'content_sources') return sourceChain
        return createMockChain({ data: null, error: null })
      })

      await POST(failingItemRequest())

      expect(getPayload()).toMatchObject({ status: 'error', items_skipped: 0 })
    })

    it('marks sync_logs status=partial when a real write lands alongside a failure', async () => {
      // 'error' means NO real write landed; a legit no-op skip is not progress.
      // So a genuine partial needs an actual create/update to succeed. Item 1's
      // Strategy-1 lookup matches (update succeeds); item 2's errors (throws).
      const { logChain, getPayload } = captureLogUpdate()
      let call = 0
      const sourceChain = {
        select: () => ({
          eq: () => ({
            maybeSingle: () => {
              call++
              return Promise.resolve(
                call === 1
                  ? { data: { id: 100, content_item_id: 50 }, error: null }
                  : { data: null, error: { message: 'DB down' } }
              )
            },
          }),
        }),
        update: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ error: null }),
          }),
        }),
      }
      const contentChain = createMockChain({ data: null, error: null })
      mockFrom.mockImplementation((table: string) => {
        if (table === 'sync_logs') return logChain
        if (table === 'content_sources') return sourceChain
        if (table === 'content_items') return contentChain
        return createMockChain({ data: null, error: null })
      })

      const request = createRequest({
        source: 'spotify',
        secret: MOCK_SECRET,
        items: [
          { title: 'Matched', author: 'X', externalId: 'spotify:episode:1', progress: '10', status: 'In Progress' },
          { title: 'Doomed', author: 'X', externalId: 'spotify:episode:2' },
        ],
      })

      const data = await (await POST(request)).json()

      expect(data.updated).toBe(1)
      expect(data.errors).toBe(1)
      expect(data.success).toBe(false)
      expect(getPayload()).toMatchObject({ status: 'partial' })
    })

    it('reports itemErrors in sync_logs metadata so /settings/status can show it', async () => {
      const { logChain, getPayload } = captureLogUpdate()
      const sourceChain = createMockChain({ data: null, error: { message: 'DB down' } })
      mockFrom.mockImplementation((table: string) => {
        if (table === 'sync_logs') return logChain
        if (table === 'content_sources') return sourceChain
        return createMockChain({ data: null, error: null })
      })

      await POST(failingItemRequest())

      expect(getPayload()).toMatchObject({ metadata: { itemErrors: 1 } })
    })
  })

  describe('log service (#269)', () => {
    function failingItemRequest() {
      return createRequest({
        source: 'spotify',
        secret: MOCK_SECRET,
        items: [{ title: 'Doomed', author: 'Author', externalId: 'spotify:episode:x', progress: '10' }],
      })
    }

    function captureLogUpdate() {
      let payload: Record<string, unknown> | null = null
      const logChain = createMockChain({ data: { id: 1 }, error: null })
      logChain.update = vi.fn().mockImplementation((p: Record<string, unknown>) => {
        payload = p
        return { eq: vi.fn().mockResolvedValue({ error: null }) }
      })
      return { logChain, getPayload: () => payload }
    }

    it('reports an all-items-failed run (status=error)', async () => {
      // Same setup as "marks sync_logs status=error when every item fails".
      const { logChain } = captureLogUpdate()
      const sourceChain = createMockChain({ data: null, error: { message: 'DB down' } })
      mockFrom.mockImplementation((table: string) => {
        if (table === 'sync_logs') return logChain
        if (table === 'content_sources') return sourceChain
        return createMockChain({ data: null, error: null })
      })

      await POST(failingItemRequest())

      expect(mockLogError).toHaveBeenCalledWith(
        'sync',
        expect.anything(),
        expect.objectContaining({ itemErrors: expect.any(Number) }),
      )
    })

    it('reports an unhandled outer-catch error', async () => {
      // Body parsing, secret, source, and items validation all succeed; the
      // sync_logs insert's terminal .single() rejects outright (rather than
      // resolving { error }) so the throw lands in the outer catch before
      // syncLogId is ever assigned.
      const logChain = createMockChain({ data: { id: 1 }, error: null })
      logChain.single = vi.fn().mockRejectedValue(new Error('insert boom'))
      mockFrom.mockImplementation((table: string) => {
        if (table === 'sync_logs') return logChain
        return createMockChain({ data: null, error: null })
      })

      const response = await POST(createRequest({ source: 'spotify', secret: MOCK_SECRET, items: [] }))
      expect(response.status).toBe(500)

      expect(mockLogError).toHaveBeenCalledWith('sync', expect.anything(), expect.anything())
    })

    it('reports a sync_logs update failure', async () => {
      // Healthy (empty-items) run, but the finalizing sync_logs update fails.
      const logChain = createMockChain({ data: { id: 1 }, error: null })
      logChain.update = vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: { message: 'boom' } }),
      })
      mockFrom.mockImplementation((table: string) => {
        if (table === 'sync_logs') return logChain
        return createMockChain({ data: null, error: null })
      })

      await POST(createRequest({ source: 'spotify', secret: MOCK_SECRET, items: [] }))

      expect(mockLogError).toHaveBeenCalledWith(
        'sync',
        expect.anything(),
        expect.objectContaining({ blindSpot: 'sync_logs-write' }),
      )
    })

    it('does not log a partial run (some writes landed)', async () => {
      // Same setup as "marks sync_logs status=partial when a real write lands
      // alongside a failure".
      const { logChain } = captureLogUpdate()
      let call = 0
      const sourceChain = {
        select: () => ({
          eq: () => ({
            maybeSingle: () => {
              call++
              return Promise.resolve(
                call === 1
                  ? { data: { id: 100, content_item_id: 50 }, error: null }
                  : { data: null, error: { message: 'DB down' } }
              )
            },
          }),
        }),
        update: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ error: null }),
          }),
        }),
      }
      const contentChain = createMockChain({ data: null, error: null })
      mockFrom.mockImplementation((table: string) => {
        if (table === 'sync_logs') return logChain
        if (table === 'content_sources') return sourceChain
        if (table === 'content_items') return contentChain
        return createMockChain({ data: null, error: null })
      })

      const request = createRequest({
        source: 'spotify',
        secret: MOCK_SECRET,
        items: [
          { title: 'Matched', author: 'X', externalId: 'spotify:episode:1', progress: '10', status: 'In Progress' },
          { title: 'Doomed', author: 'X', externalId: 'spotify:episode:2' },
        ],
      })

      await POST(request)

      expect(mockLogError).not.toHaveBeenCalled()
    })
  })
  describe('item error samples (#337)', () => {
    function captureLogUpdate() {
      let payload: Record<string, unknown> | null = null
      const logChain = createMockChain({ data: { id: 1 }, error: null })
      logChain.update = vi.fn().mockImplementation((p: Record<string, unknown>) => {
        payload = p
        return { eq: vi.fn().mockResolvedValue({ error: null }) }
      })
      return { logChain, getPayload: () => payload }
    }

    const deadlock = { message: 'deadlock detected', code: '40P01', details: 'Process 1 waits for ShareLock' }

    function doomedRequest() {
      return createRequest({
        source: 'substack',
        secret: MOCK_SECRET,
        items: [{ title: 'Doomed post', author: 'Author', externalId: 'substack:post:1', progress: '10' }],
      })
    }

    it('puts source, item count, codes and samples in the all-failed alert', async () => {
      const { logChain } = captureLogUpdate()
      const sourceChain = createMockChain({ data: null, error: deadlock })
      mockFrom.mockImplementation((table: string) => {
        if (table === 'sync_logs') return logChain
        if (table === 'content_sources') return sourceChain
        return createMockChain({ data: null, error: null })
      })

      await POST(doomedRequest())

      expect(mockLogError).toHaveBeenCalledWith(
        'sync',
        'all 1 item write(s) failed; nothing persisted',
        expect.objectContaining({
          source: 'substack',
          itemCount: 1,
          itemErrors: 1,
          codes: ['40P01'],
          samples: [{ title: 'Doomed post', code: '40P01', message: 'deadlock detected' }],
          syncLogId: 1,
        }),
      )
    })

    it('reports a failed sync_logs insert alongside the item failures', async () => {
      const logChain = createMockChain({ data: null, error: { message: 'connection refused', code: '08006' } })
      const sourceChain = createMockChain({ data: null, error: deadlock })
      mockFrom.mockImplementation((table: string) => {
        if (table === 'sync_logs') return logChain
        if (table === 'content_sources') return sourceChain
        return createMockChain({ data: null, error: null })
      })

      await POST(doomedRequest())

      const extra = mockLogError.mock.calls[0][2]
      expect(extra.syncLogInsertError).toEqual({ message: 'connection refused', details: { code: '08006' } })
      expect(extra.syncLogId).toBeUndefined()
      expect(extra).not.toHaveProperty('error')
    })

    it('records codes and samples in sync_logs metadata for error runs', async () => {
      const { logChain, getPayload } = captureLogUpdate()
      const sourceChain = createMockChain({ data: null, error: deadlock })
      mockFrom.mockImplementation((table: string) => {
        if (table === 'sync_logs') return logChain
        if (table === 'content_sources') return sourceChain
        return createMockChain({ data: null, error: null })
      })

      await POST(doomedRequest())

      expect(getPayload()).toMatchObject({
        status: 'error',
        metadata: {
          itemErrors: 1,
          codes: ['40P01'],
          samples: [{ title: 'Doomed post', code: '40P01', message: 'deadlock detected' }],
        },
      })
    })

    it('records codes and samples in sync_logs metadata for partial runs too', async () => {
      const { logChain, getPayload } = captureLogUpdate()
      let call = 0
      const sourceChain = {
        select: () => ({
          eq: () => ({
            maybeSingle: () => {
              call++
              return Promise.resolve(
                call === 1
                  ? { data: { id: 100, content_item_id: 50 }, error: null }
                  : { data: null, error: deadlock }
              )
            },
          }),
        }),
        update: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ error: null }),
          }),
        }),
      }
      const contentChain = createMockChain({ data: null, error: null })
      mockFrom.mockImplementation((table: string) => {
        if (table === 'sync_logs') return logChain
        if (table === 'content_sources') return sourceChain
        if (table === 'content_items') return contentChain
        return createMockChain({ data: null, error: null })
      })

      await POST(createRequest({
        source: 'spotify',
        secret: MOCK_SECRET,
        items: [
          { title: 'Matched', author: 'X', externalId: 'spotify:episode:1', progress: '10', status: 'In Progress' },
          { title: 'Doomed', author: 'X', externalId: 'spotify:episode:2' },
        ],
      }))

      expect(getPayload()).toMatchObject({
        status: 'partial',
        metadata: { itemErrors: 1, codes: ['40P01'], samples: [{ title: 'Doomed', code: '40P01' }] },
      })
      expect(mockLogError).not.toHaveBeenCalled()
    })
  })
})
