import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  fetchSavedEpisodes,
  fetchEpisode,
  fetchShowEpisodePages,
  fetchEpisodesByIds,
  fetchEpisodes,
  fetchSavedShows,
  saveToLibrary,
  SpotifyApiError,
  isSpotifyServerError,
  type ShowEpisode,
} from './client'

const EP = (id: string): ShowEpisode => ({
  id,
  name: `Episode ${id}`,
  duration_ms: 1000,
  release_date: '2026-07-18',
  external_urls: { spotify: `https://open.spotify.com/episode/${id}` },
})

function mockFetchSequence(
  responses: Array<{
    ok: boolean
    status?: number
    statusText?: string
    retryAfter?: string
    body?: unknown
  }>
) {
  const fn = vi.fn()
  for (const r of responses) {
    fn.mockResolvedValueOnce({
      ok: r.ok,
      status: r.status ?? 200,
      statusText: r.statusText ?? 'OK',
      headers: { get: (h: string) => (h === 'Retry-After' ? (r.retryAfter ?? null) : null) },
      json: async () => r.body,
    })
  }
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchShowEpisodePages', () => {
  it('yields pages and follows next links', async () => {
    const fetchMock = mockFetchSequence([
      {
        ok: true,
        body: {
          items: [EP('a'), EP('b')],
          next: 'https://api.spotify.com/v1/shows/x/episodes?offset=50',
          total: 3,
        },
      },
      { ok: true, body: { items: [EP('c')], next: null, total: 3 } },
    ])
    const pages: ShowEpisode[][] = []
    for await (const page of fetchShowEpisodePages('showid', 'token')) pages.push(page)
    expect(pages.map((p) => p.map((e) => e.id))).toEqual([['a', 'b'], ['c']])
    expect(fetchMock.mock.calls[0][0]).toContain('/shows/showid/episodes?limit=50')
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer token')
  })

  it('lets the caller stop paging early (no second fetch)', async () => {
    const fetchMock = mockFetchSequence([
      { ok: true, body: { items: [EP('a')], next: 'https://api.spotify.com/next', total: 2 } },
    ])
    for await (const page of fetchShowEpisodePages('showid', 'token')) {
      expect(page).toHaveLength(1)
      break
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('filters null placeholder episodes', async () => {
    mockFetchSequence([{ ok: true, body: { items: [EP('a'), null, EP('b')], next: null, total: 3 } }])
    const pages: ShowEpisode[][] = []
    for await (const page of fetchShowEpisodePages('showid', 'token')) pages.push(page)
    expect(pages[0].map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('retries a page once when 429 carries a short Retry-After', async () => {
    const fetchMock = mockFetchSequence([
      { ok: false, status: 429, statusText: 'Too Many Requests', retryAfter: '0' },
      { ok: true, body: { items: [EP('a')], next: null, total: 1 } },
    ])
    const pages: ShowEpisode[][] = []
    for await (const page of fetchShowEpisodePages('showid', 'token')) pages.push(page)
    expect(pages).toHaveLength(1)
    expect(pages[0][0].id).toBe('a')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws on a second consecutive 429 for the same page', async () => {
    mockFetchSequence([
      { ok: false, status: 429, statusText: 'Too Many Requests', retryAfter: '0' },
      { ok: false, status: 429, statusText: 'Too Many Requests', retryAfter: '0' },
    ])
    const iterate = async () => {
      for await (const _ of fetchShowEpisodePages('showid', 'token')) void _
    }
    await expect(iterate()).rejects.toMatchObject({
      name: 'SpotifyApiError',
      statusCode: 429,
      retryAfter: 0,
    })
  })

  it('throws immediately on 429 without a usable Retry-After', async () => {
    mockFetchSequence([{ ok: false, status: 429, statusText: 'Too Many Requests' }])
    const iterate = async () => {
      for await (const _ of fetchShowEpisodePages('showid', 'token')) void _
    }
    await expect(iterate()).rejects.toMatchObject({
      name: 'SpotifyApiError',
      statusCode: 429,
      retryAfter: undefined,
    })
  })

  it('throws SpotifyApiError on non-429 client errors', async () => {
    mockFetchSequence([{ ok: false, status: 403, statusText: 'Forbidden' }])
    const iterate = async () => {
      for await (const _ of fetchShowEpisodePages('showid', 'token')) void _
    }
    await expect(iterate()).rejects.toMatchObject({
      name: 'SpotifyApiError',
      statusCode: 403,
    })
  })
})

const FULL_EP = (id: string, show: string) => ({
  id,
  name: `Episode ${id}`,
  duration_ms: 1000,
  release_date: '2026-07-18',
  show: { id: `show-${show}`, name: show },
  external_urls: { spotify: `https://open.spotify.com/episode/${id}` },
})

describe('fetchEpisodesByIds (#245 show-name backfill)', () => {
  it('returns a map of episode id → show name', async () => {
    const fetchMock = mockFetchSequence([
      { ok: true, body: { episodes: [FULL_EP('a', 'Astral Codex Ten'), FULL_EP('b', 'AI Article Readings')] } },
    ])
    const result = await fetchEpisodesByIds(['a', 'b'], 'token')
    expect(result.get('a')).toBe('Astral Codex Ten')
    expect(result.get('b')).toBe('AI Article Readings')
    expect(fetchMock.mock.calls[0][0]).toContain('/episodes?ids=a,b')
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer token')
  })

  it('batches into requests of at most 50 ids', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `e${i}`)
    const fetchMock = mockFetchSequence([
      { ok: true, body: { episodes: ids.slice(0, 50).map((id) => FULL_EP(id, 'S')) } },
      { ok: true, body: { episodes: ids.slice(50, 100).map((id) => FULL_EP(id, 'S')) } },
      { ok: true, body: { episodes: ids.slice(100).map((id) => FULL_EP(id, 'S')) } },
    ])
    const result = await fetchEpisodesByIds(ids, 'token')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(result.size).toBe(120)
  })

  it('skips null placeholder episodes and those without a show name', async () => {
    mockFetchSequence([
      { ok: true, body: { episodes: [FULL_EP('a', 'Real Show'), null, { id: 'c', name: 'X', show: null }] } },
    ])
    const result = await fetchEpisodesByIds(['a', 'b', 'c'], 'token')
    expect(result.get('a')).toBe('Real Show')
    expect(result.has('b')).toBe(false)
    expect(result.has('c')).toBe(false)
  })

  it('makes no request for an empty id list', async () => {
    const fetchMock = mockFetchSequence([])
    const result = await fetchEpisodesByIds([], 'token')
    expect(result.size).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('retries a batch once on a short Retry-After 429', async () => {
    const fetchMock = mockFetchSequence([
      { ok: false, status: 429, statusText: 'Too Many Requests', retryAfter: '0' },
      { ok: true, body: { episodes: [FULL_EP('a', 'Show')] } },
    ])
    const result = await fetchEpisodesByIds(['a'], 'token')
    expect(result.get('a')).toBe('Show')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws SpotifyApiError on a non-retryable error', async () => {
    mockFetchSequence([{ ok: false, status: 401, statusText: 'Unauthorized' }])
    await expect(fetchEpisodesByIds(['a'], 'token')).rejects.toMatchObject({
      name: 'SpotifyApiError',
      statusCode: 401,
    })
  })
})

/**
 * Tests for the Spotify Web API client's single-episode fetch (#194).
 *
 * fetchEpisode backs the duration backfill: it must survive removed/region-
 * blocked episodes (404 → null, not a throw) while still surfacing real API
 * failures (429 with Retry-After) as SpotifyApiError.
 */

describe('fetchEpisode', () => {
  it('returns the episode duration on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'abc123', duration_ms: 3661000 }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const episode = await fetchEpisode('token', 'abc123')

    expect(episode).toEqual({ duration_ms: 3661000 })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.spotify.com/v1/episodes/abc123?market=from_token',
      { headers: { Authorization: 'Bearer token' } }
    )
  })

  it('returns null when the episode no longer exists (404)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: { get: () => null },
      })
    )

    await expect(fetchEpisode('token', 'gone')).resolves.toBeNull()
  })

  it('throws SpotifyApiError with Retry-After on 429', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: { get: (name: string) => (name === 'Retry-After' ? '30' : null) },
      })
    )

    const err = await fetchEpisode('token', 'busy').catch((e) => e)
    expect(err).toBeInstanceOf(SpotifyApiError)
    expect(err.statusCode).toBe(429)
    expect(err.retryAfter).toBe(30)
  })
})

describe('fetchShowEpisodePages limit (#310)', () => {
  it('requests the given page size', async () => {
    const fetchFn = mockFetchSequence([{ ok: true, body: { items: [EP('a')], next: null, total: 1 } }])
    const pages = fetchShowEpisodePages('show1', 'tok', { limit: 10 })
    await pages.next()
    expect(fetchFn.mock.calls[0][0]).toContain('/shows/show1/episodes?limit=10&')
  })

  it('defaults to 50 per page', async () => {
    const fetchFn = mockFetchSequence([{ ok: true, body: { items: [], next: null, total: 0 } }])
    await fetchShowEpisodePages('show1', 'tok').next()
    expect(fetchFn.mock.calls[0][0]).toContain('limit=50')
  })
})

describe('fetchSavedShows (#310)', () => {
  it('follows next links and returns every followed show', async () => {
    const show = (id: string) => ({ added_at: '2026-01-01T00:00:00Z', show: { id, name: `Show ${id}` } })
    const fetchFn = mockFetchSequence([
      { ok: true, body: { items: [show('a'), show('b')], next: 'https://api.spotify.com/v1/me/shows?offset=2' } },
      { ok: true, body: { items: [show('c')], next: null } },
    ])
    const shows = await fetchSavedShows('tok')
    expect(shows.map((s) => s.show.id)).toEqual(['a', 'b', 'c'])
    expect(fetchFn.mock.calls[0][0]).toContain('/me/shows?limit=50')
    expect(fetchFn.mock.calls[1][0]).toBe('https://api.spotify.com/v1/me/shows?offset=2')
  })

  it('throws SpotifyApiError on failure', async () => {
    mockFetchSequence([{ ok: false, status: 403, statusText: 'Forbidden' }])
    await expect(fetchSavedShows('tok')).rejects.toBeInstanceOf(SpotifyApiError)
  })

  it('retries a page once on a short Retry-After 429', async () => {
    vi.useFakeTimers()
    const fetchFn = mockFetchSequence([
      { ok: false, status: 429, statusText: 'Too Many Requests', retryAfter: '1' },
      { ok: true, body: { items: [], next: null } },
    ])
    const done = fetchSavedShows('tok')
    await vi.advanceTimersByTimeAsync(1000)
    await expect(done).resolves.toEqual([])
    expect(fetchFn).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})

describe('saveToLibrary (#310)', () => {
  it('PUTs the uris as a comma-separated query param', async () => {
    const fetchFn = mockFetchSequence([{ ok: true }])
    await saveToLibrary('tok', ['spotify:episode:a', 'spotify:episode:b'])
    const [url, init] = fetchFn.mock.calls[0]
    expect(init.method).toBe('PUT')
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(new URL(url).pathname).toBe('/v1/me/library')
    expect(new URL(url).searchParams.get('uris')).toBe('spotify:episode:a,spotify:episode:b')
  })

  it('chunks into requests of at most 40 uris', async () => {
    const uris = Array.from({ length: 85 }, (_, i) => `spotify:episode:${i}`)
    const fetchFn = mockFetchSequence([{ ok: true }, { ok: true }, { ok: true }])
    await saveToLibrary('tok', uris)
    const sizes = fetchFn.mock.calls.map(([url]) => new URL(url).searchParams.get('uris')!.split(',').length)
    expect(sizes).toEqual([40, 40, 5])
  })

  it('makes no request for an empty list', async () => {
    const fetchFn = mockFetchSequence([])
    await saveToLibrary('tok', [])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('throws SpotifyApiError carrying the status on 403 (missing scope)', async () => {
    mockFetchSequence([{ ok: false, status: 403, statusText: 'Forbidden' }])
    const err = await saveToLibrary('tok', ['spotify:episode:a']).catch((e) => e)
    expect(err).toBeInstanceOf(SpotifyApiError)
    expect(err.statusCode).toBe(403)
  })

  it('retries once on a short Retry-After 429', async () => {
    vi.useFakeTimers()
    const fetchFn = mockFetchSequence([
      { ok: false, status: 429, statusText: 'Too Many Requests', retryAfter: '1' },
      { ok: true },
    ])
    const done = saveToLibrary('tok', ['spotify:episode:a'])
    await vi.advanceTimersByTimeAsync(1000)
    await done
    expect(fetchFn).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})

describe('fetchEpisodes (#329 unsaved queue episodes)', () => {
  it('returns full episodes with resume points, dropping null placeholders', async () => {
    const played = { ...FULL_EP('a', 'Show'), resume_point: { fully_played: true, resume_position_ms: 0 } }
    const fetchMock = mockFetchSequence([{ ok: true, body: { episodes: [played, null] } }])
    const result = await fetchEpisodes(['a', 'gone'], 'token')
    expect(result).toEqual([played])
    expect(fetchMock.mock.calls[0][0]).toContain('/episodes?ids=a,gone&market=from_token')
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer token')
  })

  it('batches into requests of at most 50 ids', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `e${i}`)
    const fetchMock = mockFetchSequence([
      { ok: true, body: { episodes: ids.slice(0, 50).map((id) => FULL_EP(id, 'S')) } },
      { ok: true, body: { episodes: ids.slice(50).map((id) => FULL_EP(id, 'S')) } },
    ])
    const result = await fetchEpisodes(ids, 'token')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result).toHaveLength(60)
  })

  it('makes no request for an empty id list', async () => {
    const fetchMock = mockFetchSequence([])
    expect(await fetchEpisodes([], 'token')).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws SpotifyApiError on a non-retryable error', async () => {
    mockFetchSequence([{ ok: false, status: 400, statusText: 'Bad Request' }])
    await expect(fetchEpisodes(['a'], 'token')).rejects.toMatchObject({
      name: 'SpotifyApiError',
      statusCode: 400,
    })
  })
})

describe('transient 5xx / network retry (#342)', () => {
  // Spotify answers the odd 502/503/504 (and the odd dropped connection);
  // every client call retries those twice with jittered backoff before
  // giving up, so one gateway blip no longer fails a whole sync run.
  afterEach(() => vi.useRealTimers())

  const OK_BODIES = {
    savedEpisodes: { items: [], next: null, total: 0, limit: 50, offset: 0 },
    episode: { duration_ms: 1234 },
    showPage: { items: [], next: null, total: 0 },
    episodesByIds: { episodes: [] },
    savedShows: { items: [], next: null },
    library: undefined,
  }

  const CALLS: Array<[string, unknown, () => Promise<unknown>]> = [
    ['fetchSavedEpisodes', OK_BODIES.savedEpisodes, () => fetchSavedEpisodes('tok')],
    ['fetchEpisode', OK_BODIES.episode, () => fetchEpisode('tok', 'ep1')],
    [
      'fetchShowEpisodePages',
      OK_BODIES.showPage,
      async () => {
        for await (const _ of fetchShowEpisodePages('showid', 'tok')) void _
      },
    ],
    ['fetchEpisodesByIds', OK_BODIES.episodesByIds, () => fetchEpisodesByIds(['a'], 'tok')],
    ['fetchEpisodes', OK_BODIES.episodesByIds, () => fetchEpisodes(['a'], 'tok')],
    ['fetchSavedShows', OK_BODIES.savedShows, () => fetchSavedShows('tok')],
    ['saveToLibrary', OK_BODIES.library, () => saveToLibrary('tok', ['spotify:episode:a'])],
  ]

  it.each(CALLS)('%s retries a 503 and then succeeds', async (_name, body, call) => {
    vi.useFakeTimers()
    const fetchFn = mockFetchSequence([
      { ok: false, status: 503, statusText: 'Service Unavailable' },
      { ok: true, body },
    ])
    const done = call()
    await vi.runAllTimersAsync()
    await expect(done).resolves.not.toThrow()
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it.each(CALLS)('%s gives up after two retries of a 5xx', async (_name, _body, call) => {
    vi.useFakeTimers()
    const fetchFn = mockFetchSequence([
      { ok: false, status: 502, statusText: 'Bad Gateway' },
      { ok: false, status: 504, statusText: 'Gateway Timeout' },
      { ok: false, status: 502, statusText: 'Bad Gateway' },
    ])
    const done = call()
    const assertion = expect(done).rejects.toMatchObject({
      name: 'SpotifyApiError',
      statusCode: 502,
      message: 'Spotify API error: Bad Gateway',
    })
    await vi.runAllTimersAsync()
    await assertion
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it.each(CALLS)('%s does not retry a 401', async (_name, _body, call) => {
    const fetchFn = mockFetchSequence([{ ok: false, status: 401, statusText: 'Unauthorized' }])
    await expect(call()).rejects.toMatchObject({ name: 'SpotifyApiError', statusCode: 401 })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('retries a network TypeError and then succeeds', async () => {
    vi.useFakeTimers()
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null },
        json: async () => OK_BODIES.savedShows,
      })
    vi.stubGlobal('fetch', fetchFn)
    const done = fetchSavedShows('tok')
    await vi.runAllTimersAsync()
    await expect(done).resolves.toEqual([])
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
})

describe('isSpotifyServerError (#342)', () => {
  it('is true only for a SpotifyApiError with a 5xx status', () => {
    expect(isSpotifyServerError(new SpotifyApiError('Spotify API error: Bad Gateway', 502))).toBe(true)
    expect(isSpotifyServerError(new SpotifyApiError('Spotify API error: Server Error', 500))).toBe(true)
    expect(isSpotifyServerError(new SpotifyApiError('Spotify API error: Unauthorized', 401))).toBe(false)
    expect(isSpotifyServerError(new SpotifyApiError('Spotify API error: Too Many Requests', 429))).toBe(false)
    expect(isSpotifyServerError(new Error('Gateway Timeout'))).toBe(false)
    expect(isSpotifyServerError({ statusCode: 502 })).toBe(false)
  })
})
