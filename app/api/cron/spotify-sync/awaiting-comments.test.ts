import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GET } from './route'

const mock = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), episodes: vi.fn(), create: vi.fn(), candidates: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: mock.rpc, from: mock.from } }))
vi.mock('@/lib/spotify/auth', () => ({ getAccessToken: vi.fn().mockResolvedValue('token'), SpotifyAuthError: class extends Error {} }))
vi.mock('@/lib/spotify/client', () => ({ fetchSavedEpisodes: mock.episodes, SpotifyApiError: class extends Error {}, isSpotifyServerError: () => false }))
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
vi.mock('next/server', async (original) => ({ ...await original<typeof import('next/server')>(), after: vi.fn() }))
vi.mock('@/lib/sync/matching', async (original) => ({
  ...await original<typeof import('@/lib/sync/matching')>(),
  fetchAuthorCandidates: mock.candidates, createContent: mock.create,
  ensureSpotifySourceFromCache: vi.fn(), updateSourceProgress: vi.fn(),
}))

function chain(data: unknown) {
  const value = { data, error: null }
  const query: Record<string, unknown> = {}
  for (const name of ['select', 'in', 'eq', 'is', 'update', 'insert']) query[name] = vi.fn(() => query)
  query.single = vi.fn(async () => value)
  query.then = (resolve: (v: unknown) => void) => Promise.resolve(value).then(resolve)
  return query
}
function episode(progress = 960_000, fullyPlayed = false) {
  return { added_at: '2026-01-01', episode: { id: 'test', name: 'Post', show: { name: 'Show' },
    duration_ms: 1_000_000, resume_point: { resume_position_ms: progress, fully_played: fullyPlayed },
    external_urls: { spotify: 'https://open.spotify.com/episode/test' }, release_date: '2026-01-01', images: [] } }
}
const request = () => new Request('http://localhost/api/cron/spotify-sync', { headers: { authorization: 'Bearer test-266' } })

beforeEach(() => {
  vi.clearAllMocks()
  process.env.SYNC_API_SECRET = 'test-266'
  mock.rpc.mockResolvedValue({ error: null })
  mock.episodes.mockResolvedValue([episode()])
  mock.candidates.mockResolvedValue([])
  mock.create.mockResolvedValue({ contentItemId: 50 })
  mock.from.mockImplementation((table: string) => table === 'sync_logs' ? chain({ id: 1 }) : table === 'content_items'
    ? chain([{ id: 50, duration_seconds: 1000 }])
    : chain([{ id: 1, content_item_id: 50, external_id: 'spotify:episode:test', link: 'https://open.spotify.com/episode/test', progress: 96, source_label: 'Show' }]))
})

describe('Spotify completion persistence (#266)', () => {
  it.each([[960_000, false, '96'], [900_000, false, '90'], [10_000, true, '1']] as const)(
    'sends completion (%s, fully-played=%s) to the source-aware RPC', async (position, played, progress) => {
      mock.episodes.mockResolvedValue([episode(position, played)])
      expect((await GET(request())).status).toBe(200)
      expect(mock.rpc).toHaveBeenCalledWith('apply_spotify_progress', { updates: [{ id: 50, status: 'Completed', progress, source: 'spotify' }] })
      expect(mock.rpc).not.toHaveBeenCalledWith('batch_update_content_items', expect.anything())
    },
  )
  it('uses the same policy for newly created items', async () => {
    mock.from.mockImplementation((table: string) => table === 'sync_logs' ? chain({ id: 1 }) : chain([]))
    expect((await GET(request())).status).toBe(200)
    expect(mock.create).toHaveBeenCalled()
    expect(mock.rpc).toHaveBeenCalledWith('apply_spotify_progress', { updates: [{ id: 50, status: 'Completed', progress: '96', source: 'spotify' }] })
  })
  it('reports a persistence failure instead of a successful sync', async () => {
    mock.rpc.mockResolvedValue({ error: { message: 'write failed' } })
    expect((await GET(request())).status).toBe(500)
  })
})
