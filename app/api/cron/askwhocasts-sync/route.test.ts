import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GET } from './route'

const MOCK_SECRET = 'test-secret-123'
// Fake fixture URL only — the real ASKWHOCASTS_FEED_URL is a bearer secret and
// must never appear in real feed calls, logs, or sync_logs rows.
const FAKE_FEED_URL = 'https://fake-feed.example/awc/abc123-secret-token'

// Mock Supabase client
const mockFrom = vi.fn()
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: vi.fn(),
  },
}))

// Mock the SSRF-guarded feed fetcher (#206) — fetchFeed(url, parser) resolves parsed feed output.
const mockFetchFeed = vi.fn()
vi.mock('@/lib/rss/fetch-feed', () => ({
  fetchFeed: (...args: unknown[]) => mockFetchFeed(...args),
}))

// Mock the Askwho Casts episode parsing/matching helpers (private phase).
const mockParseAwcEpisodes = vi.fn()
const mockSyncEpisode = vi.fn()
vi.mock('@/lib/sync/askwhocasts', () => ({
  parseAwcEpisodes: (...args: unknown[]) => mockParseAwcEpisodes(...args),
  syncEpisode: (...args: unknown[]) => mockSyncEpisode(...args),
}))

// Mock the public-show sync (#237) and Spotify auth it depends on.
const mockSyncPublicEpisodes = vi.fn()
vi.mock('@/lib/sync/askwhocasts-public', () => ({
  syncPublicEpisodes: (...args: unknown[]) => mockSyncPublicEpisodes(...args),
}))
const mockGetAccessToken = vi.fn()
vi.mock('@/lib/spotify/auth', () => ({
  getAccessToken: (...args: unknown[]) => mockGetAccessToken(...args),
}))

// Mock auth (session-cookie fallback path)
const mockGetSession = vi.fn()
vi.mock('@/lib/auth', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}))

const mockLogError = vi.fn().mockResolvedValue(undefined)
const mockLogWarn = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/logger', () => ({
  logError: (...a: unknown[]) => mockLogError(...a),
  logWarn: (...a: unknown[]) => mockLogWarn(...a),
}))

// Helper to create request with auth
function createRequest(bearerToken?: string): Request {
  const headers: Record<string, string> = {}
  if (bearerToken) {
    headers['authorization'] = `Bearer ${bearerToken}`
  }
  return new Request('http://localhost/api/cron/askwhocasts-sync', {
    method: 'GET',
    headers,
  })
}

/**
 * Renders a console.error mock's captured calls to a single searchable
 * string. Deliberately NOT JSON.stringify(calls) — Error's `message` and
 * `stack` are non-enumerable own properties, so JSON.stringify(error)
 * silently produces "{}" and would hide a leaked secret inside a raw Error
 * object passed straight to console.error.
 */
function flattenConsoleCalls(calls: unknown[][]): string {
  return calls
    .flatMap((args) =>
      args.map((arg) => {
        if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ''}`
        if (typeof arg === 'string') return arg
        try {
          return JSON.stringify(arg)
        } catch {
          return String(arg)
        }
      })
    )
    .join('\n')
}

/**
 * Tracks every sync_logs row the route creates/updates, keyed by insert order
 * (the route runs its phases sequentially: private first when configured,
 * then public). `logFor(source)` finds a row by its insert payload's source.
 */
let syncLogRows: { id: number; insert: Record<string, unknown>; update?: Record<string, unknown> }[] = []

function logFor(source: string) {
  return syncLogRows.find((row) => row.insert.source === source)
}

function setupSyncLogsMock(options: { updateError?: { message: string } } = {}) {
  syncLogRows = []
  mockFrom.mockImplementation((table: string) => {
    if (table === 'sync_logs') {
      return {
        // insert → select('id') → single() — creates the sync_log row
        insert: (payload: Record<string, unknown>) => {
          const id = syncLogRows.length + 1
          syncLogRows.push({ id, insert: payload })
          return {
            select: () => ({
              single: () => Promise.resolve({ data: { id }, error: null }),
            }),
          }
        },
        // update → eq('id', id) — finalizes the matching sync_log row
        update: (payload: Record<string, unknown>) => ({
          eq: (_field: string, id: number) => {
            const row = syncLogRows.find((r) => r.id === id)
            if (row) row.update = payload
            return Promise.resolve({ error: options.updateError ?? null })
          },
        }),
      }
    }
    throw new Error(`Unexpected Supabase table access in test: ${table}`)
  })
}

/**
 * Like setupSyncLogsMock, but the sync_logs INSERT for `failSource` fails
 * outright (no row ever created for that phase) while any other source's
 * insert/update behaves normally. Used to drive each phase's `else` branch
 * ("insert failed earlier; the work ran but no row exists to mark").
 */
function setupSyncLogsInsertFailureMock(failSource: string) {
  syncLogRows = []
  mockFrom.mockImplementation((table: string) => {
    if (table === 'sync_logs') {
      return {
        insert: (payload: Record<string, unknown>) => {
          if (payload.source === failSource) {
            return {
              select: () => ({
                single: () => Promise.resolve({ data: null, error: { message: 'insert failed' } }),
              }),
            }
          }
          const id = syncLogRows.length + 1
          syncLogRows.push({ id, insert: payload })
          return {
            select: () => ({
              single: () => Promise.resolve({ data: { id }, error: null }),
            }),
          }
        },
        update: (payload: Record<string, unknown>) => ({
          eq: (_field: string, id: number) => {
            const row = syncLogRows.find((r) => r.id === id)
            if (row) row.update = payload
            return Promise.resolve({ error: null })
          },
        }),
      }
    }
    throw new Error(`Unexpected Supabase table access in test: ${table}`)
  })
}

const EMPTY_PUBLIC_RESULT = {
  processed: 0,
  attached: 0,
  skipped: 0,
  unmatched: [] as { title: string; link: string }[],
  itemErrors: 0,
}

describe('GET /api/cron/askwhocasts-sync', () => {
  beforeEach(() => {
    mockFrom.mockClear()
    mockLogWarn.mockClear()
    mockFetchFeed.mockReset()
    mockParseAwcEpisodes.mockReset()
    mockSyncEpisode.mockReset()
    mockGetSession.mockReset()
    mockSyncPublicEpisodes.mockReset()
    mockGetAccessToken.mockReset()
    mockLogError.mockClear()

    process.env.SYNC_API_SECRET = MOCK_SECRET
    process.env.ASKWHOCASTS_FEED_URL = FAKE_FEED_URL

    // Safe defaults
    mockGetSession.mockResolvedValue({ isAuthenticated: false })
    mockFetchFeed.mockResolvedValue({ items: [] })
    mockParseAwcEpisodes.mockReturnValue([])
    mockSyncEpisode.mockResolvedValue('unchanged')
    mockGetAccessToken.mockResolvedValue('spotify-token')
    mockSyncPublicEpisodes.mockResolvedValue({ ...EMPTY_PUBLIC_RESULT })
    setupSyncLogsMock()
  })

  afterEach(() => {
    delete process.env.ASKWHOCASTS_FEED_URL
  })

  it('1. returns 401 when neither bearer token nor session authenticates', async () => {
    const response = await GET(createRequest())
    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body.error).toBe('Unauthorized')
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('2. runs the public phase alone when ASKWHOCASTS_FEED_URL is unset, reporting a loud skip (no 503)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      delete process.env.ASKWHOCASTS_FEED_URL
      mockSyncPublicEpisodes.mockResolvedValue({ ...EMPTY_PUBLIC_RESULT, processed: 3, skipped: 3 })

      const response = await GET(createRequest(MOCK_SECRET))
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.success).toBe(true)
      expect(body.private).toMatchObject({
        status: 'skipped',
        reason: 'ASKWHOCASTS_FEED_URL not configured',
      })
      expect(body.public).toMatchObject({ status: 'success', processed: 3, skipped: 3 })

      expect(mockFetchFeed).not.toHaveBeenCalled()
      expect(logFor('askwhocasts')).toBeUndefined()
      expect(logFor('askwhocasts_public')?.update).toMatchObject({ status: 'success' })
      expect(warnSpy).toHaveBeenCalledWith(
        '[AWC Sync] ASKWHOCASTS_FEED_URL not configured — private phase skipped'
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('3. happy path: both phases run, each with its own sync_logs row', async () => {
    mockFetchFeed.mockResolvedValue({
      items: [
        {
          guid: 'g1',
          title: 'Ep 1',
          link: 'https://example.com/ep1',
          enclosure: { url: 'https://fake-feed.example/audio/ep1.mp3' },
        },
      ],
    })
    mockParseAwcEpisodes.mockReturnValue([
      {
        guid: 'g1',
        title: 'Ep 1',
        sourceUrl: 'https://example.com/ep1',
        enclosureUrl: 'https://fake-feed.example/audio/ep1.mp3',
      },
    ])
    mockSyncEpisode.mockResolvedValue('attached')
    mockSyncPublicEpisodes.mockResolvedValue({
      processed: 431,
      attached: 30,
      skipped: 1,
      unmatched: [{ title: 'Nope', link: 'https://open.spotify.com/episode/x' }],
      itemErrors: 0,
    })

    const response = await GET(createRequest(MOCK_SECRET))
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body.success).toBe(true)
    expect(body.private).toMatchObject({ status: 'success', attached: 1 })
    expect(body.public).toMatchObject({ status: 'success', attached: 30, unmatched: 1 })
    expect(mockSyncEpisode).toHaveBeenCalledTimes(1)
    expect(mockSyncPublicEpisodes).toHaveBeenCalledWith('spotify-token', expect.anything())

    expect(logFor('askwhocasts')?.update).toMatchObject({ status: 'success', items_created: 1 })
    expect(logFor('askwhocasts_public')?.update).toMatchObject({
      status: 'success',
      items_created: 30,
      items_skipped: 2, // skipped + unmatched
    })
  })

  it('4. unmatched private episode is reported, and sync_logs metadata omits the enclosure/feed URL', async () => {
    mockFetchFeed.mockResolvedValue({
      items: [
        {
          guid: 'g2',
          title: 'Ep 2',
          link: 'https://example.com/ep2',
          enclosure: { url: 'https://fake-feed.example/audio/ep2-secret.mp3' },
        },
      ],
    })
    mockParseAwcEpisodes.mockReturnValue([
      {
        guid: 'g2',
        title: 'Ep 2',
        sourceUrl: 'https://example.com/ep2',
        enclosureUrl: 'https://fake-feed.example/audio/ep2-secret.mp3',
      },
    ])
    mockSyncEpisode.mockResolvedValue('unmatched')

    const response = await GET(createRequest(MOCK_SECRET))
    const body = await response.json()
    expect(body.private.status).toBe('success')
    expect(body.private.unmatched).toBe(1)

    const privateUpdate = logFor('askwhocasts')?.update
    expect(privateUpdate).toBeDefined()
    expect(privateUpdate?.metadata).toMatchObject({
      unmatched: [{ title: 'Ep 2', sourceUrl: 'https://example.com/ep2' }],
    })
    // The bearer-secret enclosure URL and feed URL must never land in sync_logs.
    const serializedMetadata = JSON.stringify(privateUpdate?.metadata)
    expect(serializedMetadata).not.toContain('fake-feed.example/audio/ep2-secret.mp3')
    expect(serializedMetadata).not.toContain(FAKE_FEED_URL)
  })

  it('5. syncEpisode throwing for one episode yields a partial private run with errors: 1', async () => {
    mockFetchFeed.mockResolvedValue({
      items: [
        {
          guid: 'g3',
          title: 'Ep 3 OK',
          link: 'https://example.com/ep3',
          enclosure: { url: 'https://fake-feed.example/audio/ep3.mp3' },
        },
        {
          guid: 'g4',
          title: 'Ep 4 Boom',
          link: 'https://example.com/ep4',
          enclosure: { url: 'https://fake-feed.example/audio/ep4.mp3' },
        },
      ],
    })
    mockParseAwcEpisodes.mockReturnValue([
      {
        guid: 'g3',
        title: 'Ep 3 OK',
        sourceUrl: 'https://example.com/ep3',
        enclosureUrl: 'https://fake-feed.example/audio/ep3.mp3',
      },
      {
        guid: 'g4',
        title: 'Ep 4 Boom',
        sourceUrl: 'https://example.com/ep4',
        enclosureUrl: 'https://fake-feed.example/audio/ep4.mp3',
      },
    ])
    mockSyncEpisode
      .mockResolvedValueOnce('attached')
      .mockRejectedValueOnce(new Error('boom'))

    const response = await GET(createRequest(MOCK_SECRET))
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body.private.status).toBe('partial')
    expect(body.private.errors).toBe(1)
    expect(body.private.attached).toBe(1)
    expect(logFor('askwhocasts')?.update).toMatchObject({ status: 'partial' })
  })

  it('6. fetchFeed rejecting marks the private phase as error but the public phase still runs', async () => {
    mockFetchFeed.mockRejectedValue(new Error('feed unreachable'))
    mockSyncPublicEpisodes.mockResolvedValue({ ...EMPTY_PUBLIC_RESULT, processed: 2, attached: 2 })

    const response = await GET(createRequest(MOCK_SECRET))
    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body.success).toBe(false)
    expect(body.private).toMatchObject({ status: 'error', error: 'Internal server error' })
    expect(body.public).toMatchObject({ status: 'success', attached: 2 })

    expect(logFor('askwhocasts')?.update).toMatchObject({ status: 'error' })
    expect(logFor('askwhocasts_public')?.update).toMatchObject({ status: 'success' })
    expect(mockSyncEpisode).not.toHaveBeenCalled()
    expect(mockSyncPublicEpisodes).toHaveBeenCalledTimes(1)
  })

  it('7. an error message embedding the feed URL (e.g. safe-fetch redirect errors) is redacted before logging/storing', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      mockFetchFeed.mockRejectedValue(new Error(`Too many redirects fetching ${FAKE_FEED_URL}`))

      const response = await GET(createRequest(MOCK_SECRET))
      expect(response.status).toBe(500)

      const privateUpdate = logFor('askwhocasts')?.update
      expect(privateUpdate).toBeDefined()
      expect(privateUpdate).toMatchObject({ status: 'error' })
      const errorMessage = privateUpdate?.error_message as string
      expect(errorMessage).not.toContain(FAKE_FEED_URL)
      expect(errorMessage).toContain('[feed-url]')

      const consoleOutput = flattenConsoleCalls(consoleErrorSpy.mock.calls)
      expect(consoleOutput).not.toContain(FAKE_FEED_URL)
    } finally {
      consoleErrorSpy.mockRestore()
    }
  })

  it('8. an episode-processing error embedding the enclosure URL (same feed secret, different path) is redacted before logging', async () => {
    // FAKE_FEED_URL's path segment 'abc123-secret-token' stands in for the
    // real ASKWHOCASTS_FEED_URL's bearer secret. A realistic enclosure URL
    // carries the SAME secret at the same path position but a different
    // full URL string (.../media/<file>.mp3 vs the feed URL itself), so a
    // redaction that only matches the literal feed URL would miss it.
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const enclosureUrl = 'https://fake-feed.example/awc/abc123-secret-token/media/abc.mp3'
      mockFetchFeed.mockResolvedValue({
        items: [
          {
            guid: 'g5',
            title: 'Ep 5 Boom',
            link: 'https://example.com/ep5',
            enclosure: { url: enclosureUrl },
          },
        ],
      })
      mockParseAwcEpisodes.mockReturnValue([
        {
          guid: 'g5',
          title: 'Ep 5 Boom',
          sourceUrl: 'https://example.com/ep5',
          enclosureUrl,
        },
      ])
      mockSyncEpisode.mockRejectedValue(new Error(`insert failed for ${enclosureUrl}`))

      const response = await GET(createRequest(MOCK_SECRET))
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.private.status).toBe('partial')
      expect(body.private.errors).toBe(1)

      const consoleOutput = flattenConsoleCalls(consoleErrorSpy.mock.calls)
      expect(consoleOutput).not.toContain('abc123-secret-token')
      expect(consoleOutput).not.toContain(enclosureUrl)
    } finally {
      consoleErrorSpy.mockRestore()
    }
  })

  it('9. Spotify auth failure marks the public phase as error without touching the private phase', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      mockGetAccessToken.mockRejectedValue(new Error('refresh token expired'))

      const response = await GET(createRequest(MOCK_SECRET))
      expect(response.status).toBe(500)
      const body = await response.json()
      expect(body.success).toBe(false)
      expect(body.private).toMatchObject({ status: 'success' })
      expect(body.public.status).toBe('error')
      expect(body.public.error).toContain('refresh token expired')

      expect(logFor('askwhocasts')?.update).toMatchObject({ status: 'success' })
      expect(logFor('askwhocasts_public')?.update).toMatchObject({ status: 'error' })
      expect(mockSyncPublicEpisodes).not.toHaveBeenCalled()
    } finally {
      consoleErrorSpy.mockRestore()
    }
  })

  it('10. public unmatched metadata is capped at 50 entries with the true total recorded', async () => {
    const unmatched = Array.from({ length: 60 }, (_, i) => ({
      title: `Episode ${i}`,
      link: `https://open.spotify.com/episode/ep${i}`,
    }))
    mockSyncPublicEpisodes.mockResolvedValue({
      processed: 60,
      attached: 0,
      skipped: 0,
      unmatched,
      itemErrors: 0,
    })

    const response = await GET(createRequest(MOCK_SECRET))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.public.unmatched).toBe(60)

    const publicUpdate = logFor('askwhocasts_public')?.update
    expect(publicUpdate).toBeDefined()
    const metadata = publicUpdate?.metadata as {
      unmatched: unknown[]
      unmatchedTotal: number
    }
    expect(metadata.unmatched).toHaveLength(50)
    expect(metadata.unmatchedTotal).toBe(60)
    expect(publicUpdate).toMatchObject({ items_skipped: 60 })
  })

  it('12. a public sync_logs update failure surfaces as syncLogError with success: false', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      setupSyncLogsMock({ updateError: { message: 'db down' } })
      mockSyncPublicEpisodes.mockResolvedValue({ ...EMPTY_PUBLIC_RESULT, processed: 1, attached: 1 })

      const response = await GET(createRequest(MOCK_SECRET))
      expect(response.status).toBe(500)
      const body = await response.json()
      expect(body.success).toBe(false)
      expect(body.public).toMatchObject({ status: 'success', syncLogError: 'db down' })
      // Private phase hits the same failing update and reports it the same way.
      expect(body.private).toMatchObject({ syncLogError: 'db down' })
    } finally {
      consoleErrorSpy.mockRestore()
    }
  })

  it('11. public itemErrors yield a partial public phase', async () => {
    mockSyncPublicEpisodes.mockResolvedValue({
      processed: 5,
      attached: 3,
      skipped: 1,
      unmatched: [],
      itemErrors: 1,
    })

    const response = await GET(createRequest(MOCK_SECRET))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.success).toBe(true)
    expect(body.public).toMatchObject({ status: 'partial', attached: 3, errors: 1 })
    expect(logFor('askwhocasts_public')?.update).toMatchObject({
      status: 'partial',
      items_created: 3,
      items_skipped: 1,
    })
  })

  describe('log service (#269)', () => {
    it('reports a private-phase error with the redacted message (never the feed secret)', async () => {
      // Same setup as test 7 (redaction): error message embeds the feed URL.
      mockFetchFeed.mockRejectedValue(new Error(`Too many redirects fetching ${FAKE_FEED_URL}`))

      await GET(createRequest(MOCK_SECRET))

      expect(mockLogError).toHaveBeenCalled()
      const [ctx, msg] = mockLogError.mock.calls[0]
      expect(ctx).toBe('askwhocasts-sync')
      expect(String(msg)).not.toContain(FAKE_FEED_URL)
      expect(String(msg)).toContain('[feed-url]')
    })

    it('reports a public-phase error', async () => {
      // Same setup as test 9 (Spotify auth failure).
      mockGetAccessToken.mockRejectedValue(new Error('refresh token expired'))

      await GET(createRequest(MOCK_SECRET))

      expect(mockLogError).toHaveBeenCalledWith(
        'askwhocasts-public-sync',
        expect.anything(),
        expect.anything(),
      )
    })

    it('logs a Spotify 5xx that survived the client retries at warn, still marking the phase errored (#342)', async () => {
      const { SpotifyApiError } = await import('@/lib/spotify/client')
      mockSyncPublicEpisodes.mockRejectedValue(
        new SpotifyApiError('Spotify API error: Bad Gateway', 502),
      )

      await GET(createRequest(MOCK_SECRET))

      expect(mockLogWarn).toHaveBeenCalledWith(
        'askwhocasts-public-sync',
        'SpotifyApiError: Spotify API error: Bad Gateway',
        expect.objectContaining({ spotifyStatus: 502 }),
      )
      expect(mockLogError).not.toHaveBeenCalledWith(
        'askwhocasts-public-sync',
        expect.anything(),
        expect.anything(),
      )
      const publicRow = syncLogRows.find((r) => r.insert.source === 'askwhocasts_public')
      expect(publicRow?.update).toMatchObject({ status: 'error' })
    })

    it('keeps a non-5xx Spotify API error at error, with its status (#342)', async () => {
      const { SpotifyApiError } = await import('@/lib/spotify/client')
      mockSyncPublicEpisodes.mockRejectedValue(
        new SpotifyApiError('Spotify API error: Unauthorized', 401),
      )

      await GET(createRequest(MOCK_SECRET))

      expect(mockLogError).toHaveBeenCalledWith(
        'askwhocasts-public-sync',
        'SpotifyApiError: Spotify API error: Unauthorized',
        expect.objectContaining({ spotifyStatus: 401 }),
      )
      expect(mockLogWarn).not.toHaveBeenCalled()
    })

    it('reports a sync_logs update failure', async () => {
      // Same setup as test 12.
      setupSyncLogsMock({ updateError: { message: 'db down' } })
      mockSyncPublicEpisodes.mockResolvedValue({ ...EMPTY_PUBLIC_RESULT, processed: 1, attached: 1 })

      await GET(createRequest(MOCK_SECRET))

      expect(mockLogError).toHaveBeenCalledWith(
        'askwhocasts-public-sync',
        expect.anything(),
        expect.objectContaining({ blindSpot: 'sync_logs-write' }),
      )
    })

    it('reports a private-phase sync_logs insert failure', async () => {
      // The private-phase sync_logs INSERT fails outright — syncLogId stays
      // null, falling into that phase's `else` branch ("insert failed
      // earlier; no row exists to mark") instead of the update-failure one.
      setupSyncLogsInsertFailureMock('askwhocasts')

      await GET(createRequest(MOCK_SECRET))

      expect(mockLogError).toHaveBeenCalledWith(
        'askwhocasts-sync',
        expect.anything(),
        expect.objectContaining({ blindSpot: 'sync_logs-write' }),
      )
    })

    it('reports a public-phase sync_logs insert failure', async () => {
      setupSyncLogsInsertFailureMock('askwhocasts_public')

      await GET(createRequest(MOCK_SECRET))

      expect(mockLogError).toHaveBeenCalledWith(
        'askwhocasts-public-sync',
        expect.anything(),
        expect.objectContaining({ blindSpot: 'sync_logs-write' }),
      )
    })

    it('does not log on a healthy dual-phase run', async () => {
      // Same setup as test 3 (happy path, both phases succeed).
      mockFetchFeed.mockResolvedValue({
        items: [
          {
            guid: 'g1',
            title: 'Ep 1',
            link: 'https://example.com/ep1',
            enclosure: { url: 'https://fake-feed.example/audio/ep1.mp3' },
          },
        ],
      })
      mockParseAwcEpisodes.mockReturnValue([
        {
          guid: 'g1',
          title: 'Ep 1',
          sourceUrl: 'https://example.com/ep1',
          enclosureUrl: 'https://fake-feed.example/audio/ep1.mp3',
        },
      ])
      mockSyncEpisode.mockResolvedValue('attached')
      mockSyncPublicEpisodes.mockResolvedValue({
        processed: 431,
        attached: 30,
        skipped: 1,
        unmatched: [{ title: 'Nope', link: 'https://open.spotify.com/episode/x' }],
        itemErrors: 0,
      })

      await GET(createRequest(MOCK_SECRET))

      expect(mockLogError).not.toHaveBeenCalled()
    })
  })
})
