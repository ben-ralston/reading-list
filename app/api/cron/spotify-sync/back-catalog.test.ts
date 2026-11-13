/**
 * Back-catalog guard (#305): following This American Life Partners dumped the
 * show's archive into Spotify saved episodes, and every sync imported another
 * batch of decades-old, unplayed episodes into the queue (each one also firing
 * a background summary). The route must not create items for a show's
 * back-catalog dump, while still importing new episodes, played episodes, and
 * a lone deliberately saved old episode.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GET } from './route'
import { BACK_CATALOG_MIN_SHOW_COUNT } from '@/lib/spotify/back-catalog'

const mock = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  episodes: vi.fn(),
  create: vi.fn(),
  candidates: vi.fn(),
  after: vi.fn(),
  syncLogUpdates: [] as Record<string, unknown>[],
}))
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: mock.rpc, from: mock.from } }))
vi.mock('@/lib/spotify/auth', () => ({
  getAccessToken: vi.fn().mockResolvedValue('token'),
  SpotifyAuthError: class extends Error {},
}))
vi.mock('@/lib/spotify/client', () => ({
  fetchSavedEpisodes: mock.episodes,
  SpotifyApiError: class extends Error {},
  isSpotifyServerError: () => false,
}))
vi.mock('@/lib/spotify/unsaved-episodes', () => ({
  fetchUnsavedQueueEpisodes: vi.fn().mockResolvedValue([]),
}))
// Bearer runs also run the #310 show-gap scan; it has its own tests
// (show-gap.test.ts) — here it finds nothing so these scenarios are unchanged.
vi.mock('@/lib/spotify/show-gaps', () => ({
  recoverShowGaps: vi.fn().mockResolvedValue({
    recovered: [],
    report: { shows_scanned: 0, missing: 0, saved: 0, by_show: {}, episodes: [] },
  }),
}))
vi.mock('@/lib/summary', () => ({ generateSummary: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logError: vi.fn() }))
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: mock.after,
}))
vi.mock('@/lib/sync/matching', async (original) => ({
  ...(await original<typeof import('@/lib/sync/matching')>()),
  fetchAuthorCandidates: mock.candidates,
  createContent: mock.create,
  updateContentProgress: vi.fn(),
  ensureSpotifySourceFromCache: vi.fn(),
  updateSourceProgress: vi.fn(),
}))

function chain(data: unknown, onUpdate?: (payload: Record<string, unknown>) => void) {
  const value = { data, error: null }
  const query: Record<string, unknown> = {}
  for (const name of ['select', 'in', 'eq', 'is', 'insert']) query[name] = vi.fn(() => query)
  query.update = vi.fn((payload: Record<string, unknown>) => {
    onUpdate?.(payload)
    return query
  })
  query.single = vi.fn(async () => value)
  query.then = (resolve: (v: unknown) => void) => Promise.resolve(value).then(resolve)
  return query
}

let nextId = 0
function saved(opts: {
  show: string
  release: string
  addedAt?: string
  resumeMs?: number
}) {
  const id = `ep${nextId++}`
  return {
    added_at: opts.addedAt ?? '2026-09-23T14:10:00Z',
    episode: {
      id,
      name: `Episode ${id}`,
      show: { id: 'show', name: opts.show },
      duration_ms: 3_600_000,
      release_date: opts.release,
      resume_point: { resume_position_ms: opts.resumeMs ?? 0, fully_played: false },
      external_urls: { spotify: `https://open.spotify.com/episode/${id}` },
      images: [],
    },
  }
}

const request = () =>
  new Request('http://localhost/api/cron/spotify-sync', {
    headers: { authorization: 'Bearer test-305' },
  })

beforeEach(() => {
  vi.clearAllMocks()
  mock.syncLogUpdates.length = 0
  process.env.SYNC_API_SECRET = 'test-305'
  mock.rpc.mockResolvedValue({ error: null })
  mock.candidates.mockResolvedValue([])
  let created = 100
  mock.create.mockImplementation(async () => ({ contentItemId: created++, inserted: true }))
  // Nothing is already imported: every saved episode is a creation candidate.
  mock.from.mockImplementation((table: string) =>
    table === 'sync_logs'
      ? chain({ id: 7 }, (payload) => mock.syncLogUpdates.push(payload))
      : chain([])
  )
})

describe('Spotify sync back-catalog guard (#305)', () => {
  it("does not import a followed show's back catalog, but imports its new episode", async () => {
    const backCatalog = Array.from({ length: BACK_CATALOG_MIN_SHOW_COUNT + 3 }, (_, i) =>
      saved({ show: 'This American Life Partners', release: `${1996 + i}-05-02` })
    )
    const recent = saved({
      show: 'This American Life Partners',
      release: '2026-09-26',
      addedAt: '2026-09-26T13:00:00Z',
    })
    mock.episodes.mockResolvedValue([...backCatalog, recent])

    const res = await GET(request())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(mock.create).toHaveBeenCalledTimes(1)
    expect(mock.create.mock.calls[0][0]).toMatchObject({
      externalId: `spotify:episode:${recent.episode.id}`,
    })
    // Skipped dump items never reach the summary generator either.
    expect(mock.after).toHaveBeenCalledTimes(1)
    expect(body).toMatchObject({ created: 1, backCatalogSkipped: backCatalog.length })
  })

  it('records the skipped back catalog in the sync log metadata', async () => {
    const backCatalog = Array.from({ length: BACK_CATALOG_MIN_SHOW_COUNT }, (_, i) =>
      saved({ show: 'This American Life Partners', release: `${2000 + i}-01-01` })
    )
    mock.episodes.mockResolvedValue(backCatalog)

    await GET(request())

    const success = mock.syncLogUpdates.find((u) => u.status === 'success')
    expect(success).toMatchObject({
      items_created: 0,
      metadata: {
        trigger: 'cron',
        back_catalog_skipped: {
          total: BACK_CATALOG_MIN_SHOW_COUNT,
          by_show: { 'This American Life Partners': BACK_CATALOG_MIN_SHOW_COUNT },
        },
      },
    })
  })

  it('still imports a lone old episode saved on purpose, and old episodes being played', async () => {
    const lone = saved({ show: 'Radiolab', release: '2011-03-08' })
    const playedFromDump = Array.from({ length: BACK_CATALOG_MIN_SHOW_COUNT }, (_, i) =>
      saved({ show: 'This American Life Partners', release: `${2001 + i}-01-01`, resumeMs: 600_000 })
    )
    mock.episodes.mockResolvedValue([lone, ...playedFromDump])

    const res = await GET(request())
    const body = await res.json()

    expect(mock.create).toHaveBeenCalledTimes(1 + playedFromDump.length)
    expect(body).toMatchObject({ backCatalogSkipped: 0 })
    const success = mock.syncLogUpdates.find((u) => u.status === 'success')
    // Nothing skipped → the insert-time { trigger: 'cron' } metadata is left alone.
    expect(success).toBeDefined()
    expect(success).not.toHaveProperty('metadata')
  })
})
