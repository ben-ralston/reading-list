import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Books-mode (#42) orchestration tests for POST /api/sync.
//
// Unlike route.test.ts (which runs the real matching layer against a mocked
// Supabase), this file mocks the matching collaborators directly. The behavior
// under test is the ROUTE's branching — which collaborator it calls, with which
// arguments, per item.kind. The collaborators themselves are covered by
// lib/sync/matching.test.ts.

const MOCK_SECRET = 'test-secret-123'

const mockFindMatchingContent = vi.fn()
const mockUpdateContentProgress = vi.fn()
const mockUpdateSourceProgress = vi.fn()
const mockCreateContent = vi.fn()
const mockEnsureRssSource = vi.fn()
const mockShouldAutoAdd = vi.fn()

vi.mock('@/lib/sync/matching', () => ({
  findMatchingContent: (...a: unknown[]) => mockFindMatchingContent(...a),
  updateContentProgress: (...a: unknown[]) => mockUpdateContentProgress(...a),
  updateSourceProgress: (...a: unknown[]) => mockUpdateSourceProgress(...a),
  createContent: (...a: unknown[]) => mockCreateContent(...a),
  ensureRssSource: (...a: unknown[]) => mockEnsureRssSource(...a),
  shouldAutoAdd: (...a: unknown[]) => mockShouldAutoAdd(...a),
}))

const mockGenerateSummary = vi.fn().mockResolvedValue({ summary: '', generatedAt: '' })
vi.mock('@/lib/summary', () => ({
  generateSummary: (...a: unknown[]) => mockGenerateSummary(...a),
}))

// Invoke after() callbacks synchronously so we can assert summary generation.
vi.mock('next/server', async () => {
  const actual = await vi.importActual('next/server')
  return { ...actual, after: (fn: () => unknown) => Promise.resolve(fn()) }
})

const mockLogError = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/logger', () => ({
  logError: (...a: unknown[]) => mockLogError(...a),
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

// sync_logs is the only table the route touches directly (insert→select→single,
// then update→eq). Everything else is a mocked collaborator.
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

const AUDIBLE_BOOK = {
  title: 'Atomic Habits',
  author: 'James Clear',
  platform: 'Audible',
  link: 'https://www.audible.com/pd/B07XYZ',
  kind: 'book',
  externalId: 'audible:book:B07XYZ',
}

describe('POST /api/sync — books mode (#42)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SYNC_API_SECRET = MOCK_SECRET
    mockSyncLogs()
    mockShouldAutoAdd.mockReturnValue(true)
    mockCreateContent.mockResolvedValue({ contentItemId: 999, inserted: true })
    mockUpdateContentProgress.mockResolvedValue(undefined)
    mockUpdateSourceProgress.mockResolvedValue(undefined)
    mockEnsureRssSource.mockResolvedValue('inserted')
  })

  afterEach(() => {
    delete process.env.SYNC_API_SECRET
  })

  describe('merge path (existing item matched)', () => {
    it('attaches the Audible source to the resolved content item', async () => {
      mockFindMatchingContent.mockResolvedValue({ contentItemId: 50, action: 'update' })

      const res = await POST(
        createRequest({
          source: 'audible',
          secret: MOCK_SECRET,
          items: [{ ...AUDIBLE_BOOK, progress: '42', status: 'In Progress' }],
        })
      )
      const data = await res.json()

      expect(data.updated).toBe(1)
      expect(mockUpdateContentProgress).toHaveBeenCalledWith(50, '42', 'In Progress', expect.anything(), { source: 'audible', skipArchived: true })
      expect(mockEnsureRssSource).toHaveBeenCalledWith(
        50,
        'Audible',
        'https://www.audible.com/pd/B07XYZ',
        'audible:book:B07XYZ',
        expect.anything()
      )
    })

    it('tolerates a 23505 unique-violation on attach (counts as updated, not skipped)', async () => {
      mockFindMatchingContent.mockResolvedValue({ contentItemId: 50, action: 'update' })
      mockEnsureRssSource.mockRejectedValue(Object.assign(new Error('duplicate key'), { code: '23505' }))

      const res = await POST(
        createRequest({
          source: 'audible',
          secret: MOCK_SECRET,
          items: [{ ...AUDIBLE_BOOK, progress: '42', status: 'In Progress' }],
        })
      )
      const data = await res.json()

      expect(data.updated).toBe(1)
      expect(data.skipped).toBe(0)
    })

    it('does NOT attach a source for a matched feed item (regression)', async () => {
      mockFindMatchingContent.mockResolvedValue({ contentItemId: 50, action: 'update' })

      const res = await POST(
        createRequest({
          source: 'elevenreader',
          secret: MOCK_SECRET,
          items: [
            {
              title: 'Some Article',
              author: 'Some Author',
              platform: 'ElevenReader',
              kind: 'feed',
              externalId: 'elevenreader:xyz',
              progress: '30',
            },
          ],
        })
      )
      const data = await res.json()

      expect(data.updated).toBe(1)
      expect(mockUpdateContentProgress).toHaveBeenCalledWith(50, '30', null, expect.anything(), { source: 'elevenreader', skipArchived: false })
      expect(mockEnsureRssSource).not.toHaveBeenCalled()
    })
  })

  describe('create path (no match)', () => {
    beforeEach(() => {
      mockFindMatchingContent.mockResolvedValue(null)
    })

    it('skips smart-positioning and applies Completed status for a finished audiobook', async () => {
      const res = await POST(
        createRequest({
          source: 'audible',
          secret: MOCK_SECRET,
          items: [{ ...AUDIBLE_BOOK, progress: '100', status: 'Completed' }],
        })
      )
      const data = await res.json()

      expect(data.created).toBe(1)
      expect(mockCreateContent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'book', status: 'Completed' }),
        'audible',
        expect.anything(),
        { skipPositioning: true }
      )
      expect(mockUpdateContentProgress).toHaveBeenCalledWith(999, '100', 'Completed', expect.anything(), { source: 'audible' })
      expect(mockGenerateSummary).not.toHaveBeenCalled()
    })

    it('positions and applies In Progress status for a started audiobook', async () => {
      const res = await POST(
        createRequest({
          source: 'audible',
          secret: MOCK_SECRET,
          items: [{ ...AUDIBLE_BOOK, progress: '42', status: 'In Progress' }],
        })
      )
      const data = await res.json()

      expect(data.created).toBe(1)
      expect(mockCreateContent).toHaveBeenCalledWith(
        expect.anything(),
        'audible',
        expect.anything(),
        { skipPositioning: false }
      )
      expect(mockUpdateContentProgress).toHaveBeenCalledWith(999, '42', 'In Progress', expect.anything(), { source: 'audible' })
      expect(mockGenerateSummary).not.toHaveBeenCalled()
    })

    it('does not generate an AI summary for any new book', async () => {
      await POST(
        createRequest({
          source: 'audible',
          secret: MOCK_SECRET,
          items: [{ ...AUDIBLE_BOOK }],
        })
      )

      expect(mockGenerateSummary).not.toHaveBeenCalled()
    })

    it('generates a summary and does NOT apply progress-on-create for a new feed item (regression)', async () => {
      const res = await POST(
        createRequest({
          source: 'elevenreader',
          secret: MOCK_SECRET,
          items: [
            {
              title: 'Some Article',
              author: 'Some Author',
              platform: 'ElevenReader',
              kind: 'feed',
              externalId: 'elevenreader:xyz',
              progress: '30',
            },
          ],
        })
      )
      const data = await res.json()

      expect(data.created).toBe(1)
      expect(mockCreateContent).toHaveBeenCalledWith(
        expect.anything(),
        'elevenreader',
        expect.anything(),
        { skipPositioning: false }
      )
      expect(mockUpdateContentProgress).not.toHaveBeenCalled()
      expect(mockGenerateSummary).toHaveBeenCalledTimes(1)
    })
  })
})
