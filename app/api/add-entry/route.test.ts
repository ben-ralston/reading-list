import { describe, it, expect, vi, beforeEach } from 'vitest'
import { after } from 'next/server'
import { POST } from './route'

// Mock entry parser (parseEntry only — the route also uses the real
// isDegenerateTitle guard, so pass the rest of the module through)
const mockParseEntry = vi.fn()
vi.mock('@/lib/entry-parser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entry-parser')>()
  return {
    ...actual,
    parseEntry: (...args: unknown[]) => mockParseEntry(...args),
  }
})

// Mock sync matching functions
const mockFindMatchingContent = vi.fn()
const mockCreateContent = vi.fn()
vi.mock('@/lib/sync/matching', () => ({
  findMatchingContent: (...args: unknown[]) => mockFindMatchingContent(...args),
  createContent: (...args: unknown[]) => mockCreateContent(...args),
}))

// Mock Supabase
vi.mock('@/lib/supabase', () => ({
  supabase: {},
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

// Mock auth — the route accepts either a valid session cookie (browser + button)
// or a SHARE_API_SECRET bearer token (iOS Share Sheet, #191). Default the mocked
// session to authenticated so the existing browser-path tests keep passing; the
// dedicated auth tests below override it per-case.
const mockGetSession = vi.fn()
vi.mock('@/lib/auth', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}))

const mockLogError = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/logger', () => ({
  logError: (...a: unknown[]) => mockLogError(...a),
}))

const mockPinContentItem = vi.fn()
vi.mock('@/lib/content/shortlist-writes', () => ({
  pinContentItem: (...a: unknown[]) => mockPinContentItem(...a),
}))

const SHARE_SECRET = 'test-share-secret-123'

function createRequest(body: unknown, bearerToken?: string): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (bearerToken) headers['authorization'] = `Bearer ${bearerToken}`
  return new Request('http://localhost/api/add-entry', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

describe('POST /api/add-entry', () => {
  beforeEach(() => {
    mockParseEntry.mockClear()
    mockFindMatchingContent.mockClear()
    mockCreateContent.mockClear()
    vi.mocked(after).mockClear()
    // Authenticated browser session by default; SHARE_API_SECRET present.
    mockGetSession.mockResolvedValue({ isAuthenticated: true })
    process.env.SHARE_API_SECRET = SHARE_SECRET
    mockLogError.mockClear()
    mockPinContentItem.mockReset()
    mockPinContentItem.mockResolvedValue({ id: 42 })
  })

  describe('auth (#191)', () => {
    it('returns 401 with no session and no bearer token', async () => {
      mockGetSession.mockResolvedValue({ isAuthenticated: false })
      const response = await POST(createRequest({ input: 'https://example.com' }))
      expect(response.status).toBe(401)
    })

    it('returns 401 with a wrong bearer token and no session', async () => {
      mockGetSession.mockResolvedValue({ isAuthenticated: false })
      const response = await POST(createRequest({ input: 'https://example.com' }, 'wrong-token'))
      expect(response.status).toBe(401)
    })

    it('authenticates via the SHARE_API_SECRET bearer token (no session)', async () => {
      mockGetSession.mockResolvedValue({ isAuthenticated: false })
      mockParseEntry.mockResolvedValue({
        title: 'Shared Article',
        author: 'Author',
        platform: 'Website',
        link: 'https://example.com/a',
      })
      mockFindMatchingContent.mockResolvedValue(null)
      mockCreateContent.mockResolvedValue({ contentItemId: 5, inserted: true })

      const response = await POST(
        createRequest({ input: 'https://example.com/a' }, SHARE_SECRET),
      )
      expect(response.status).toBe(200)
      expect((await response.json()).action).toBe('created')
    })

    it('authenticates via the session cookie with no bearer (browser + button)', async () => {
      mockParseEntry.mockResolvedValue({
        title: 'Cookie Article',
        author: 'Author',
        platform: 'Website',
        link: 'https://example.com/c',
      })
      mockFindMatchingContent.mockResolvedValue(null)
      mockCreateContent.mockResolvedValue({ contentItemId: 6, inserted: true })

      const response = await POST(createRequest({ input: 'https://example.com/c' }))
      expect(response.status).toBe(200)
    })
  })

  describe('input validation', () => {
    it('rejects requests with missing input', async () => {
      const response = await POST(createRequest({}))
      expect(response.status).toBe(400)
      // Error message updated when /api/add-entry gained the structured-input
      // path for the books AddBookDialog (#147).
      expect((await response.json()).error).toMatch(/input|title.*author.*platform/i)
    })

    it('rejects requests with empty input', async () => {
      const response = await POST(createRequest({ input: '' }))
      expect(response.status).toBe(400)
    })

    it('rejects requests with whitespace-only input', async () => {
      const response = await POST(createRequest({ input: '   ' }))
      expect(response.status).toBe(400)
    })

    it('rejects requests with non-string input', async () => {
      const response = await POST(createRequest({ input: 123 }))
      expect(response.status).toBe(400)
    })
  })

  describe('URL parsing flow', () => {
    it('parses a URL, creates content, and returns details', async () => {
      mockParseEntry.mockResolvedValue({
        title: 'Test Article',
        author: 'Jane Doe',
        platform: 'Website',
        link: 'https://example.com/article',
      })
      mockFindMatchingContent.mockResolvedValue(null)
      mockCreateContent.mockResolvedValue({ contentItemId: 42, inserted: true })

      const response = await POST(createRequest({ input: 'https://example.com/article' }))
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.success).toBe(true)
      expect(data.action).toBe('created')
      expect(data.title).toBe('Test Article')
      expect(data.author).toBe('Jane Doe')
    })

    it('trims whitespace from input', async () => {
      mockParseEntry.mockResolvedValue({
        title: 'Test',
        author: 'Author',
        platform: 'Website',
        link: 'https://example.com',
      })
      mockFindMatchingContent.mockResolvedValue(null)
      mockCreateContent.mockResolvedValue({ contentItemId: 1, inserted: true })

      await POST(createRequest({ input: '  https://example.com  ' }))

      expect(mockParseEntry).toHaveBeenCalledWith('https://example.com')
    })
  })

  describe('duplicate detection', () => {
    it('returns existing action when content already exists', async () => {
      mockParseEntry.mockResolvedValue({
        title: 'Existing Article',
        author: 'Jane Doe',
        platform: 'Substack',
        link: 'https://example.substack.com/p/existing',
      })
      mockFindMatchingContent.mockResolvedValue({ contentItemId: 1, action: 'update' })

      const response = await POST(createRequest({ input: 'https://example.substack.com/p/existing' }))
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.action).toBe('existing')
      expect(mockCreateContent).not.toHaveBeenCalled()
    })
  })

  describe('error handling', () => {
    it('distinguishes a metadata-fetch failure (502, stage: metadata) from a DB write (#176)', async () => {
      mockParseEntry.mockRejectedValue(new Error('Failed to fetch URL: 404'))

      const response = await POST(createRequest({ input: 'https://example.com/bad' }))
      const data = await response.json()

      // A link/metadata failure must not look like a save failure, and must
      // never report success.
      expect(response.status).toBe(502)
      expect(data.stage).toBe('metadata')
      expect(data.success).toBeUndefined()
      expect(typeof data.error).toBe('string')
    })

    it('returns a 500 insert error (never success) when createContent fails (#176)', async () => {
      mockParseEntry.mockResolvedValue({
        title: 'New Post',
        author: 'Author',
        platform: 'Substack',
        link: 'https://example.substack.com/p/new',
      })
      mockFindMatchingContent.mockResolvedValue(null)
      mockCreateContent.mockRejectedValue(new Error('positioning shift failed'))

      const response = await POST(createRequest({ input: 'https://example.substack.com/p/new' }))
      const data = await response.json()

      expect(response.status).toBe(500)
      expect(data.stage).toBe('insert')
      expect(data.success).toBeUndefined()
      expect(typeof data.error).toBe('string')
    })

    it('returns 422 (stage: metadata) when no title extracted', async () => {
      mockParseEntry.mockResolvedValue({
        title: '',
        author: '',
        platform: 'Website',
        link: 'https://example.com',
      })

      const response = await POST(createRequest({ input: 'https://example.com' }))
      const data = await response.json()
      expect(response.status).toBe(422)
      expect(data.stage).toBe('metadata')
    })

    it('returns 422 (stage: metadata) for a degenerate scraped title like "- YouTube" (#176)', async () => {
      // YouTube bot-walls datacenter IPs; the scrape fallback then extracts the
      // literal "- YouTube" page title. Persisting it creates an invisible junk
      // row that magnetizes all future failed adds via dedup.
      mockParseEntry.mockResolvedValue({
        title: '- YouTube',
        author: '',
        platform: 'Website',
        link: 'https://youtu.be/abc123',
      })

      const response = await POST(createRequest({ input: 'https://youtu.be/abc123' }))
      const data = await response.json()

      expect(response.status).toBe(422)
      expect(data.stage).toBe('metadata')
      expect(mockFindMatchingContent).not.toHaveBeenCalled()
      expect(mockCreateContent).not.toHaveBeenCalled()
    })
  })

  describe('raw-URL fallback (#191)', () => {
    it('saves a raw item when metadata fetch throws and saveRawOnFailure is set', async () => {
      mockParseEntry.mockRejectedValue(new Error('Failed to fetch URL: 403'))
      mockFindMatchingContent.mockResolvedValue(null)
      mockCreateContent.mockResolvedValue({ contentItemId: 200, inserted: true })

      const response = await POST(
        createRequest({ input: 'https://blocked.example.com/x', saveRawOnFailure: true }),
      )
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.action).toBe('created')
      expect(data.fallback).toBe(true)
      // Raw item: the URL is the visible "needs cleanup" title; hostname (www
      // stripped) satisfies the RPC's non-empty author/platform constraint.
      expect(mockCreateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'https://blocked.example.com/x',
          author: 'blocked.example.com',
          platform: 'blocked.example.com',
          link: 'https://blocked.example.com/x',
        }),
        'tasklet',
        expect.anything(),
        { addedBy: 'Ben' },
      )
    })

    it('saves a raw item when the scraped title is degenerate and saveRawOnFailure is set', async () => {
      mockParseEntry.mockResolvedValue({
        title: '- YouTube',
        author: '',
        platform: 'Website',
        link: 'https://youtu.be/abc123',
      })
      mockFindMatchingContent.mockResolvedValue(null)
      mockCreateContent.mockResolvedValue({ contentItemId: 201, inserted: true })

      const response = await POST(
        createRequest({ input: 'https://youtu.be/abc123', saveRawOnFailure: true }),
      )
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.fallback).toBe(true)
      expect(mockCreateContent).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'https://youtu.be/abc123', author: 'youtu.be' }),
        'tasklet',
        expect.anything(),
        { addedBy: 'Ben' },
      )
    })

    it('saves a raw item when no link is extracted and saveRawOnFailure is set', async () => {
      mockParseEntry.mockResolvedValue({
        title: 'Has title but no link',
        author: 'Someone',
        platform: 'Website',
        link: '',
      })
      mockFindMatchingContent.mockResolvedValue(null)
      mockCreateContent.mockResolvedValue({ contentItemId: 202, inserted: true })

      const response = await POST(
        createRequest({ input: 'https://example.com/nolink', saveRawOnFailure: true }),
      )
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.fallback).toBe(true)
    })

    it('uses the raw URL as author when the hostname is empty (e.g. http://www.)', async () => {
      // `http://www.` passes isUrl() and new URL() parses it, but the hostname
      // is empty after stripping "www." — the DB RPC rejects an empty author, so
      // the fallback must substitute the raw URL string to stay saveable.
      mockParseEntry.mockRejectedValue(new Error('Failed to fetch URL'))
      mockFindMatchingContent.mockResolvedValue(null)
      mockCreateContent.mockResolvedValue({ contentItemId: 205, inserted: true })

      const response = await POST(
        createRequest({ input: 'http://www.', saveRawOnFailure: true }),
      )
      expect(response.status).toBe(200)
      expect((await response.json()).fallback).toBe(true)
      expect(mockCreateContent).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'http://www.', author: 'http://www.' }),
        'tasklet',
        expect.anything(),
        { addedBy: 'Ben' },
      )
    })

    it('still returns 502 on metadata failure when saveRawOnFailure is NOT set (#176 regression guard)', async () => {
      mockParseEntry.mockRejectedValue(new Error('Failed to fetch URL: 403'))

      const response = await POST(createRequest({ input: 'https://blocked.example.com/x' }))
      expect(response.status).toBe(502)
      expect(mockCreateContent).not.toHaveBeenCalled()
    })

    it('does NOT fall back for non-URL input even when saveRawOnFailure is set', async () => {
      mockParseEntry.mockRejectedValue(new Error('web search failed'))

      const response = await POST(
        createRequest({ input: 'some plain text title', saveRawOnFailure: true }),
      )
      expect(response.status).toBe(502)
      expect(mockCreateContent).not.toHaveBeenCalled()
    })

    it('dedups a re-shared raw URL to action "existing" (no duplicate)', async () => {
      mockParseEntry.mockRejectedValue(new Error('Failed to fetch URL: 403'))
      mockFindMatchingContent.mockResolvedValue({ contentItemId: 9, action: 'update' })

      const response = await POST(
        createRequest({ input: 'https://blocked.example.com/x', saveRawOnFailure: true }),
      )
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.action).toBe('existing')
      expect(mockCreateContent).not.toHaveBeenCalled()
    })

    it('skips the background summary for a raw fallback item', async () => {
      mockParseEntry.mockRejectedValue(new Error('Failed to fetch URL: 403'))
      mockFindMatchingContent.mockResolvedValue(null)
      mockCreateContent.mockResolvedValue({ contentItemId: 203, inserted: true })

      await POST(createRequest({ input: 'https://blocked.example.com/x', saveRawOnFailure: true }))

      expect(after).not.toHaveBeenCalled()
    })

    it('still schedules the background summary for a normally-enriched feed item', async () => {
      mockParseEntry.mockResolvedValue({
        title: 'Enriched',
        author: 'Author',
        platform: 'Website',
        link: 'https://example.com/enriched',
      })
      mockFindMatchingContent.mockResolvedValue(null)
      mockCreateContent.mockResolvedValue({ contentItemId: 204, inserted: true })

      await POST(createRequest({ input: 'https://example.com/enriched' }))

      expect(after).toHaveBeenCalled()
    })
  })

  describe('content creation', () => {
    it('creates content with manuallyRequested flag', async () => {
      mockParseEntry.mockResolvedValue({
        title: 'New Post',
        author: 'Author',
        platform: 'Substack',
        link: 'https://example.substack.com/p/new',
      })
      mockFindMatchingContent.mockResolvedValue(null)
      mockCreateContent.mockResolvedValue({ contentItemId: 42, inserted: true })

      await POST(createRequest({ input: 'https://example.substack.com/p/new' }))

      expect(mockCreateContent).toHaveBeenCalledWith(
        expect.objectContaining({ manuallyRequested: true }),
        'tasklet',
        expect.anything(),
        { addedBy: 'Ben' },
      )
    })

    it('defaults a missing author to "Unknown" BEFORE the dedup check (#176)', async () => {
      // The dedup lookup and the insert must see the same author. Previously
      // matching ran with author '' (matched nothing) while the insert defaulted
      // to 'Unknown' — so the DB RPC's own title+author dedup could hit an item
      // the app-level matcher missed, and the route then tried to queue-position
      // that pre-existing (possibly Completed/archived) item → CHECK violation.
      mockParseEntry.mockResolvedValue({
        title: 'Authorless Post',
        author: '',
        platform: 'Website',
        link: 'https://example.com/post',
      })
      mockFindMatchingContent.mockResolvedValue(null)
      mockCreateContent.mockResolvedValue({ contentItemId: 7, inserted: true })

      await POST(createRequest({ input: 'https://example.com/post' }))

      expect(mockFindMatchingContent).toHaveBeenCalledWith(
        expect.objectContaining({ author: 'Unknown' }),
        expect.anything()
      )
      expect(mockCreateContent).toHaveBeenCalledWith(
        expect.objectContaining({ author: 'Unknown' }),
        'tasklet',
        expect.anything(),
        { addedBy: 'Ben' },
      )
    })

    it('defaults a whitespace-only author to "Unknown" too', async () => {
      // The DB RPC raises "Author is required" for whitespace-only authors, so
      // letting one through would 500 instead of falling back to 'Unknown'.
      mockParseEntry.mockResolvedValue({
        title: 'Whitespace Author Post',
        author: '   ',
        platform: 'Website',
        link: 'https://example.com/ws',
      })
      mockFindMatchingContent.mockResolvedValue(null)
      mockCreateContent.mockResolvedValue({ contentItemId: 8, inserted: true })

      await POST(createRequest({ input: 'https://example.com/ws' }))

      expect(mockCreateContent).toHaveBeenCalledWith(
        expect.objectContaining({ author: 'Unknown' }),
        'tasklet',
        expect.anything(),
        { addedBy: 'Ben' },
      )
    })

    it('returns action "existing" (not "created") when the RPC deduped onto an existing row (#176)', async () => {
      // TOCTOU window: a cron sync can insert the same item between the route's
      // dedup check and the RPC. The RPC reports inserted=false; reporting
      // "created" would be a false-success green toast for an item that may be
      // archived and invisible.
      mockParseEntry.mockResolvedValue({
        title: 'Raced Post',
        author: 'Author',
        platform: 'Substack',
        link: 'https://example.substack.com/p/raced',
      })
      mockFindMatchingContent.mockResolvedValue(null)
      mockCreateContent.mockResolvedValue({ contentItemId: 1084, inserted: false })

      const response = await POST(createRequest({ input: 'https://example.substack.com/p/raced' }))
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.action).toBe('existing')
    })
  })

  describe('structured book input (#147)', () => {
    it('creates a book without invoking the entry parser', async () => {
      mockFindMatchingContent.mockResolvedValue(null)
      mockCreateContent.mockResolvedValue({ contentItemId: 99, inserted: true })

      const response = await POST(
        createRequest({
          kind: 'book',
          title: 'Atomic Habits',
          author: 'James Clear',
          platform: 'Audible',
          link: 'https://audible.com/x',
        }),
      )

      expect(response.status).toBe(200)
      expect(mockParseEntry).not.toHaveBeenCalled()
      expect(mockCreateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Atomic Habits',
          author: 'James Clear',
          platform: 'Audible',
          link: 'https://audible.com/x',
          kind: 'book',
          manuallyRequested: true,
        }),
        'tasklet',
        expect.anything(),
        { addedBy: 'Ben' },
      )
    })

    it('accepts a Physical book with a null link', async () => {
      mockFindMatchingContent.mockResolvedValue(null)
      mockCreateContent.mockResolvedValue({ contentItemId: 100, inserted: true })

      const response = await POST(
        createRequest({
          kind: 'book',
          title: 'The Hard Thing About Hard Things',
          author: 'the owner Horowitz',
          platform: 'Physical',
          link: null,
        }),
      )

      expect(response.status).toBe(200)
      expect(mockCreateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          platform: 'Physical',
          link: null,
          kind: 'book',
        }),
        'tasklet',
        expect.anything(),
        { addedBy: 'Ben' },
      )
    })

    it('rejects structured input missing title/author/platform', async () => {
      const response = await POST(
        createRequest({ kind: 'book', title: '', author: 'X', platform: 'Audible' }),
      )
      expect(response.status).toBe(400)
    })

    it('threads agentic book metadata into createContent (#186)', async () => {
      mockFindMatchingContent.mockResolvedValue(null)
      mockCreateContent.mockResolvedValue({ contentItemId: 101, inserted: true })

      const response = await POST(
        createRequest({
          kind: 'book',
          title: 'Atomic Habits',
          author: 'James Clear',
          platform: 'Goodreads',
          link: 'https://www.goodreads.com/book/show/40121378-atomic-habits',
          subtitle: 'An Easy & Proven Way to Build Good Habits',
          series: 'Foundation #1',
          isbn13: '9780735211292',
          imageUrl: 'https://images.example.com/atomic.jpg',
          publishedOn: '2018-10-16',
        }),
      )

      expect(response.status).toBe(200)
      expect(mockCreateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          subtitle: 'An Easy & Proven Way to Build Good Habits',
          series: 'Foundation #1',
          isbn13: '9780735211292',
          imageUrl: 'https://images.example.com/atomic.jpg',
          publishedOn: '2018-10-16',
        }),
        'tasklet',
        expect.anything(),
        { addedBy: 'Ben' },
      )
    })

    it('passes null for omitted book-metadata fields (#186)', async () => {
      mockFindMatchingContent.mockResolvedValue(null)
      mockCreateContent.mockResolvedValue({ contentItemId: 102, inserted: true })

      await POST(
        createRequest({
          kind: 'book',
          title: 'Plain Book',
          author: 'Some Author',
          platform: 'Physical',
          link: null,
        }),
      )

      expect(mockCreateContent).toHaveBeenCalledWith(
        expect.objectContaining({ subtitle: null, series: null, isbn13: null, imageUrl: null }),
        'tasklet',
        expect.anything(),
        { addedBy: 'Ben' },
      )
    })

    it('accepts a Goodreads agent add with a null link (no Goodreads URL found) (#186)', async () => {
      mockFindMatchingContent.mockResolvedValue(null)
      mockCreateContent.mockResolvedValue({ contentItemId: 103, inserted: true })

      const response = await POST(
        createRequest({
          kind: 'book',
          title: 'Obscure Title',
          author: 'Unknown Author',
          platform: 'Goodreads',
          link: null,
        }),
      )

      expect(response.status).toBe(200)
      expect(mockCreateContent).toHaveBeenCalledWith(
        expect.objectContaining({ platform: 'Goodreads', link: null, kind: 'book' }),
        'tasklet',
        expect.anything(),
        { addedBy: 'Ben' },
      )
    })
  })

  describe('log service (#269)', () => {
    it('reports a matching-lookup failure (500)', async () => {
      // Make findMatchingContent reject (existing mock).
      mockParseEntry.mockResolvedValue({
        title: 'New Post',
        author: 'Author',
        platform: 'Substack',
        link: 'https://example.substack.com/p/new',
      })
      mockFindMatchingContent.mockRejectedValue(new Error('DB timeout'))

      const response = await POST(createRequest({ input: 'https://example.substack.com/p/new' }))
      expect(response.status).toBe(500)

      expect(mockLogError).toHaveBeenCalledWith('add-entry', expect.anything())
    })

    it('reports an insert failure (500)', async () => {
      // Same setup as "returns a 500 insert error (never success) when
      // createContent fails (#176)".
      mockParseEntry.mockResolvedValue({
        title: 'New Post',
        author: 'Author',
        platform: 'Substack',
        link: 'https://example.substack.com/p/new',
      })
      mockFindMatchingContent.mockResolvedValue(null)
      mockCreateContent.mockRejectedValue(new Error('positioning shift failed'))

      const response = await POST(createRequest({ input: 'https://example.substack.com/p/new' }))
      expect(response.status).toBe(500)

      expect(mockLogError).toHaveBeenCalledWith('add-entry', expect.anything())
    })

    it('does not log a 400 invalid body (client error)', async () => {
      const request = new Request('http://localhost/api/add-entry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not valid json',
      })

      const response = await POST(request)
      expect(response.status).toBe(400)

      expect(mockLogError).not.toHaveBeenCalled()
    })

    it('does not log a successful add', async () => {
      mockParseEntry.mockResolvedValue({
        title: 'Test Article',
        author: 'Jane Doe',
        platform: 'Website',
        link: 'https://example.com/article',
      })
      mockFindMatchingContent.mockResolvedValue(null)
      mockCreateContent.mockResolvedValue({ contentItemId: 42, inserted: true })

      const response = await POST(createRequest({ input: 'https://example.com/article' }))
      expect(response.status).toBe(200)

      expect(mockLogError).not.toHaveBeenCalled()
    })
  })

  // #381: hand-adds are recorded as added_by 'Ben' (the curator's "the owner chose
  // this" signal), not the old Tasklet email pipeline's 'tasklet'.
  describe("added_by 'Ben' (#381)", () => {
    it('records a free-form hand-add as added by the owner', async () => {
      mockParseEntry.mockResolvedValue({
        title: 'Hand Added', author: 'Jane Doe', platform: 'Website', link: 'https://example.com/hand',
      })
      mockFindMatchingContent.mockResolvedValue(null)
      mockCreateContent.mockResolvedValue({ contentItemId: 42, inserted: true })
      await POST(createRequest({ input: 'https://example.com/hand' }))
      expect(mockCreateContent).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Hand Added' }),
        'tasklet',
        expect.anything(),
        { addedBy: 'Ben' },
      )
    })

    it('records a structured book add as added by the owner', async () => {
      mockFindMatchingContent.mockResolvedValue(null)
      mockCreateContent.mockResolvedValue({ contentItemId: 99, inserted: true })
      await POST(createRequest({ kind: 'book', title: 'A Book', author: 'Someone', platform: 'Audible' }))
      expect(mockCreateContent).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'A Book', kind: 'book' }),
        'tasklet',
        expect.anything(),
        { addedBy: 'Ben' },
      )
    })
  })

  // #377: items the owner adds himself go straight to the top of home. Keyed on this
  // add path, never on content_items.added_by (the ingest source).
  describe('auto-pin (#377)', () => {
    const article = {
      title: 'Hand Added', author: 'Jane Doe', platform: 'Website', link: 'https://example.com/hand',
    }

    it('pins a newly created feed entry', async () => {
      mockParseEntry.mockResolvedValue(article)
      mockFindMatchingContent.mockResolvedValue(null)
      mockCreateContent.mockResolvedValue({ contentItemId: 42, inserted: true })
      const response = await POST(createRequest({ input: article.link }))
      expect((await response.json()).action).toBe('created')
      expect(mockPinContentItem).toHaveBeenCalledWith(expect.anything(), 42)
    })

    it('does not pin a book', async () => {
      mockFindMatchingContent.mockResolvedValue(null)
      mockCreateContent.mockResolvedValue({ contentItemId: 99, inserted: true })
      await POST(createRequest({ kind: 'book', title: 'A Book', author: 'Someone', platform: 'Audible' }))
      expect(mockPinContentItem).not.toHaveBeenCalled()
    })

    it('does not pin when the entry matched an existing item', async () => {
      mockParseEntry.mockResolvedValue(article)
      mockFindMatchingContent.mockResolvedValue({ contentItemId: 1, action: 'update' })
      await POST(createRequest({ input: article.link }))
      expect(mockPinContentItem).not.toHaveBeenCalled()
    })

    it('does not pin when the insert deduped onto an existing row', async () => {
      mockParseEntry.mockResolvedValue(article)
      mockFindMatchingContent.mockResolvedValue(null)
      mockCreateContent.mockResolvedValue({ contentItemId: 5, inserted: false })
      await POST(createRequest({ input: article.link }))
      expect(mockPinContentItem).not.toHaveBeenCalled()
    })

    it('logs a pin failure and still reports the entry as created', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockParseEntry.mockResolvedValue(article)
      mockFindMatchingContent.mockResolvedValue(null)
      mockCreateContent.mockResolvedValue({ contentItemId: 42, inserted: true })
      mockPinContentItem.mockRejectedValue(new Error('pin failed'))
      const response = await POST(createRequest({ input: article.link }))
      expect(response.status).toBe(200)
      expect((await response.json()).action).toBe('created')
      expect(mockLogError).toHaveBeenCalledWith('add-entry', expect.any(Error))
      spy.mockRestore()
    })
  })
})
