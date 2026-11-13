import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Apple Podcasts progress harvester (#322) orchestration tests for POST
// /api/sync. Like route.books.test.ts, the matching collaborators are mocked:
// the behavior under test is the ROUTE's branching for source
// 'apple_podcasts' — externalId-only matching, never auto-adding, and the
// Spotify listening rules (passed through as `source`).

const MOCK_SECRET = 'test-secret-123'

const mockFindMatchingContent = vi.fn()
const mockFindByExternalId = vi.fn()
const mockUpdateContentProgress = vi.fn()
const mockUpdateSourceProgress = vi.fn()
const mockCreateContent = vi.fn()
const mockEnsureRssSource = vi.fn()
const mockBackfillExternalId = vi.fn()
const mockCompleteAwaitingComments = vi.fn()

vi.mock('@/lib/sync/matching', () => ({
  findMatchingContent: (...a: unknown[]) => mockFindMatchingContent(...a),
  findByExternalId: (...a: unknown[]) => mockFindByExternalId(...a),
  updateContentProgress: (...a: unknown[]) => mockUpdateContentProgress(...a),
  updateSourceProgress: (...a: unknown[]) => mockUpdateSourceProgress(...a),
  createContent: (...a: unknown[]) => mockCreateContent(...a),
  ensureRssSource: (...a: unknown[]) => mockEnsureRssSource(...a),
  backfillExternalId: (...a: unknown[]) => mockBackfillExternalId(...a),
  completeAwaitingComments: (...a: unknown[]) => mockCompleteAwaitingComments(...a),
  shouldAutoAdd: (source: string) => source !== 'substack' && source !== 'apple_podcasts',
}))

vi.mock('@/lib/summary', () => ({
  generateSummary: vi.fn().mockResolvedValue({ summary: '', generatedAt: '' }),
}))

vi.mock('next/server', async () => {
  const actual = await vi.importActual('next/server')
  return { ...actual, after: vi.fn() }
})

vi.mock('@/lib/logger', () => ({
  logError: vi.fn().mockResolvedValue(undefined),
}))

const mockFrom = vi.fn()
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (...a: unknown[]) => mockFrom(...a),
    rpc: vi.fn(),
  },
}))

import { POST } from './route'

function createRequest(body: unknown): Request {
  return new Request('http://localhost/api/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function mockSyncLogs() {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'sync_logs') {
      return {
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 1 }, error: null }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null }),
        }),
      }
    }
    throw new Error(`Unexpected table: ${table}`)
  })
}

const PLAYED_EPISODE = {
  title: 'What is love?',
  author: 'Askwho Casts AI',
  platform: 'Askwho Casts',
  externalId: 'askwhocasts:g1',
  progress: '100',
  status: 'Completed',
}

function post(items: unknown[]) {
  return POST(createRequest({ source: 'apple_podcasts', secret: MOCK_SECRET, items }))
}

describe('POST /api/sync — apple_podcasts (#322)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SYNC_API_SECRET = MOCK_SECRET
    mockSyncLogs()
    mockUpdateContentProgress.mockResolvedValue(undefined)
    mockUpdateSourceProgress.mockResolvedValue(undefined)
  })

  afterEach(() => {
    delete process.env.SYNC_API_SECRET
  })

  describe('comments episodes (#368)', () => {
    const comments = { contentItemId: 7, sourceId: 5, sourceLabel: 'Comments', action: 'update' }
    it('finishing one completes the card through the guarded write, and never moves the item', async () => {
      mockFindByExternalId.mockResolvedValue(comments)
      const res = await post([PLAYED_EPISODE])
      expect(res.status).toBe(200)
      expect(mockUpdateContentProgress).not.toHaveBeenCalled()
      expect(mockUpdateSourceProgress).toHaveBeenCalledWith(7, 'Askwho Casts', '100', expect.anything(), 5)
      expect(mockCompleteAwaitingComments).toHaveBeenCalledWith(7, expect.anything())
    })
    // The job never resends a played episode, so order inside a batch must not
    // decide whether the card closes.
    it('finishes the article first when both arrive in one batch, comments listed first', async () => {
      const order: string[] = []
      mockUpdateContentProgress.mockImplementation(async () => { order.push('article') })
      mockCompleteAwaitingComments.mockImplementation(async () => { order.push('comments') })
      mockFindByExternalId.mockImplementation(async (externalId: string) =>
        externalId === 'askwhocasts:comments' ? comments : { ...comments, sourceId: 6, sourceLabel: null })
      const res = await post([
        { ...PLAYED_EPISODE, externalId: 'askwhocasts:comments' },
        { ...PLAYED_EPISODE, externalId: 'askwhocasts:article' },
      ])
      expect(order).toEqual(['article', 'comments'])
      expect((await res.json()).errors).toBe(0)
    })
    it('counts a failed completion as an item error', async () => {
      mockFindByExternalId.mockResolvedValue(comments)
      mockCompleteAwaitingComments.mockRejectedValue(new Error('db down'))
      const res = await post([PLAYED_EPISODE])
      expect((await res.json()).errors).toBe(1)
      mockCompleteAwaitingComments.mockReset()
    })
    it('a partial listen records only its own position', async () => {
      mockFindByExternalId.mockResolvedValue(comments)
      await post([{ ...PLAYED_EPISODE, status: 'In Progress', progress: '40' }])
      expect(mockUpdateContentProgress).not.toHaveBeenCalled()
      expect(mockCompleteAwaitingComments).not.toHaveBeenCalled()
      expect(mockUpdateSourceProgress).toHaveBeenCalledWith(7, 'Askwho Casts', '40', expect.anything(), 5)
    })
    it('an article episode still follows the listening rules', async () => {
      mockFindByExternalId.mockResolvedValue({ ...comments, sourceLabel: null })
      await post([PLAYED_EPISODE])
      expect(mockUpdateContentProgress).toHaveBeenCalled()
      expect(mockCompleteAwaitingComments).not.toHaveBeenCalled()
    })
  })

  it('accepts apple_podcasts as a sync source', async () => {
    mockFindByExternalId.mockResolvedValue(null)
    const res = await post([])
    expect(res.status).toBe(200)
  })

  it('matches by externalId only — never the title/link fallback', async () => {
    mockFindByExternalId.mockResolvedValue({ contentItemId: 42, action: 'update' })
    await post([PLAYED_EPISODE])
    expect(mockFindByExternalId).toHaveBeenCalledWith('askwhocasts:g1', expect.anything())
    expect(mockFindMatchingContent).not.toHaveBeenCalled()
  })

  it('applies progress with the listening rules and records per-source progress', async () => {
    mockFindByExternalId.mockResolvedValue({ contentItemId: 42, action: 'update' })
    const res = await post([PLAYED_EPISODE])
    const data = await res.json()

    expect(data.updated).toBe(1)
    expect(mockUpdateContentProgress).toHaveBeenCalledWith(42, '100', 'Completed', expect.anything(), {
      source: 'apple_podcasts',
      skipArchived: false,
    })
    expect(mockUpdateSourceProgress).toHaveBeenCalledWith(42, 'Askwho Casts', '100', expect.anything(), undefined)
  })

  it('writes per-source progress to the exact matched source row', async () => {
    mockFindByExternalId.mockResolvedValue({ contentItemId: 42, sourceId: 77, action: 'update' })
    await post([PLAYED_EPISODE])
    expect(mockUpdateSourceProgress).toHaveBeenCalledWith(42, 'Askwho Casts', '100', expect.anything(), 77)
  })

  it('reports unmatched externalIds so the harvester can retry them', async () => {
    mockFindByExternalId.mockImplementation(async (id: string) =>
      id === 'askwhocasts:g1' ? { contentItemId: 42, sourceId: 77, action: 'update' } : null
    )
    const res = await post([PLAYED_EPISODE, { ...PLAYED_EPISODE, externalId: 'askwhocasts:g2' }])
    const data = await res.json()
    expect(data.unmatched).toEqual(['askwhocasts:g2'])
  })

  it('skips an unmatched episode instead of creating an item', async () => {
    mockFindByExternalId.mockResolvedValue(null)
    const res = await post([PLAYED_EPISODE])
    const data = await res.json()

    expect(mockCreateContent).not.toHaveBeenCalled()
    expect(mockUpdateContentProgress).not.toHaveBeenCalled()
    expect(data.skipped).toBe(1)
    expect(data.created).toBe(0)
  })
})
