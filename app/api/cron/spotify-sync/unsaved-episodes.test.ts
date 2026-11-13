/**
 * Unsaved queue episodes wiring (#329): Spotify drops a finished episode from
 * Your Episodes, so /me/episodes stops reporting it and its queue item stayed
 * In Progress forever. The route also syncs active queue items' episodes that
 * are missing from the saved list — on the hourly cron run only, match-only
 * (never creates items) and best-effort (a lookup failure never fails the sync).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GET } from './route'

const mock = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  episodes: vi.fn(),
  unsaved: vi.fn(),
  create: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  sources: [] as Array<Record<string, unknown>>,
}))
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: mock.rpc, from: mock.from } }))
vi.mock('@/lib/spotify/auth', () => ({
  getAccessToken: vi.fn().mockResolvedValue('token'),
  SpotifyAuthError: class extends Error {},
}))
vi.mock('@/lib/spotify/client', async (original) => ({
  ...(await original<typeof import('@/lib/spotify/client')>()),
  fetchSavedEpisodes: mock.episodes,
}))
vi.mock('@/lib/spotify/unsaved-episodes', () => ({ fetchUnsavedQueueEpisodes: mock.unsaved }))
vi.mock('@/lib/spotify/show-gaps', async (original) => ({
  ...(await original<typeof import('@/lib/spotify/show-gaps')>()),
  recoverShowGaps: vi.fn().mockResolvedValue({
    recovered: [],
    report: { shows_scanned: 0, missing: 0, saved: 0, by_show: {}, episodes: [] },
  }),
}))
vi.mock('@/lib/auth', () => ({ getSession: vi.fn().mockResolvedValue({ isAuthenticated: true }) }))
vi.mock('@/lib/summary', () => ({ generateSummary: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logError: mock.logError, logWarn: mock.logWarn }))
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: vi.fn(),
}))
vi.mock('@/lib/sync/matching', async (original) => ({
  ...(await original<typeof import('@/lib/sync/matching')>()),
  fetchAuthorCandidates: vi.fn().mockResolvedValue([]),
  createContent: mock.create,
  updateContentProgress: vi.fn(),
  ensureSpotifySourceFromCache: vi.fn(),
  updateSourceProgress: vi.fn(),
}))

function chain(data: unknown) {
  const value = { data, error: null }
  const query: Record<string, unknown> = {}
  for (const name of ['select', 'in', 'eq', 'is', 'insert', 'update']) query[name] = vi.fn(() => query)
  query.single = vi.fn(async () => value)
  query.then = (resolve: (v: unknown) => void) => Promise.resolve(value).then(resolve)
  return query
}

const ZVI_EPISODE = '5gR42c8UBHEINc5x9Wkgmc'

/** A finished episode as GET /episodes returns it once it left Your Episodes. */
function finishedUnsaved(id = ZVI_EPISODE) {
  return {
    added_at: '',
    episode: {
      id,
      name: 'On Ezra Klein’s Podcast With Jensen Huang',
      show: { id: 'show', name: "Don't Worry About the Vase Podcast" },
      duration_ms: 2_980_791,
      release_date: '2026-09-25',
      resume_point: { fully_played: true, resume_position_ms: 0 },
      external_urls: { spotify: `https://open.spotify.com/episode/${id}` },
      images: [],
    },
  }
}

const cronRequest = () =>
  new Request('http://localhost/api/cron/spotify-sync', {
    headers: { authorization: 'Bearer test-329' },
  })

const progressUpdates = () =>
  mock.rpc.mock.calls
    .filter(([name]) => name === 'apply_spotify_progress')
    .flatMap(([, args]) => args.updates)

beforeEach(() => {
  vi.clearAllMocks()
  process.env.SYNC_API_SECRET = 'test-329'
  mock.rpc.mockResolvedValue({ error: null })
  mock.episodes.mockResolvedValue([])
  mock.unsaved.mockResolvedValue([])
  mock.create.mockResolvedValue({ contentItemId: 100, inserted: true })
  mock.sources = [
    {
      id: 3827,
      content_item_id: 2991,
      external_id: `spotify:episode:${ZVI_EPISODE}`,
      link: `https://open.spotify.com/episode/${ZVI_EPISODE}`,
      progress: null,
      source_label: "Don't Worry About the Vase",
    },
  ]
  mock.from.mockImplementation((table: string) => {
    if (table === 'sync_logs') return chain({ id: 7 })
    if (table === 'content_sources') return chain(mock.sources)
    return chain([])
  })
})

describe('Spotify sync of unsaved queue episodes (#329)', () => {
  it('completes a queue item whose finished episode left Your Episodes', async () => {
    mock.unsaved.mockResolvedValue([finishedUnsaved()])

    const res = await GET(cronRequest())

    expect(res.status).toBe(200)
    expect(mock.unsaved).toHaveBeenCalledWith('token', [], expect.anything())
    expect(progressUpdates()).toEqual([expect.objectContaining({ id: 2991, status: 'Completed' })])
  })

  it('skips the lookup on browser-triggered syncs', async () => {
    mock.unsaved.mockResolvedValue([finishedUnsaved()])

    const res = await GET(new Request('http://localhost/api/cron/spotify-sync'))

    expect(res.status).toBe(200)
    expect(mock.unsaved).not.toHaveBeenCalled()
    expect(progressUpdates()).toEqual([])
  })

  it('never creates queue items from unsaved episodes', async () => {
    mock.sources = []
    mock.unsaved.mockResolvedValue([finishedUnsaved('noLongerSourced')])

    const res = await GET(cronRequest())

    expect(res.status).toBe(200)
    expect(mock.create).not.toHaveBeenCalled()
    expect(progressUpdates()).toEqual([])
  })

  it('keeps syncing saved episodes and reports the failure when the lookup throws', async () => {
    mock.unsaved.mockRejectedValue(new Error('Spotify API error: Too Many Requests'))

    const res = await GET(cronRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(mock.logError).toHaveBeenCalledWith(
      'spotify-sync',
      expect.stringContaining('Too Many Requests'),
      expect.objectContaining({ blindSpot: 'unsaved-queue-episodes' })
    )
  })

  it('logs a Spotify 5xx lookup failure at warn, not error (#342)', async () => {
    const { SpotifyApiError } = await import('@/lib/spotify/client')
    mock.unsaved.mockRejectedValue(new SpotifyApiError('Spotify API error: Bad Gateway', 502))

    const res = await GET(cronRequest())

    expect(res.status).toBe(200)
    expect(mock.logError).not.toHaveBeenCalled()
    expect(mock.logWarn).toHaveBeenCalledWith(
      'spotify-sync',
      expect.stringContaining('Bad Gateway'),
      expect.objectContaining({ blindSpot: 'unsaved-queue-episodes', spotifyStatus: 502 })
    )
  })
})
