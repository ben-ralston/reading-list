/**
 * Show-gap scan wiring (#310): on the hourly cron run the route asks
 * recoverShowGaps for recent followed-show episodes that Spotify's
 * auto-download never saved, imports what it saved, and records the gap in
 * sync_logs. Browser-triggered syncs skip the scan, and a scan failure never
 * fails the sync.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GET } from './route'
import type { ShowGapResult } from '@/lib/spotify/show-gaps'
import { BACK_CATALOG_MIN_SHOW_COUNT } from '@/lib/spotify/back-catalog'

const mock = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  episodes: vi.fn(),
  recover: vi.fn(),
  create: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  session: vi.fn(),
  syncLogUpdates: [] as Record<string, unknown>[],
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
vi.mock('@/lib/spotify/unsaved-episodes', () => ({
  fetchUnsavedQueueEpisodes: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/spotify/show-gaps', async (original) => ({
  ...(await original<typeof import('@/lib/spotify/show-gaps')>()),
  recoverShowGaps: mock.recover,
}))
vi.mock('@/lib/auth', () => ({ getSession: mock.session }))
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
function saved(show: string, release: string, addedAt = '2026-09-29T14:10:00Z') {
  const id = `ep${nextId++}`
  return {
    added_at: addedAt,
    episode: {
      id,
      name: `Episode ${id}`,
      show: { id: 'show', name: show },
      duration_ms: 3_600_000,
      release_date: release,
      resume_point: { resume_position_ms: 0, fully_played: false },
      external_urls: { spotify: `https://open.spotify.com/episode/${id}` },
      images: [],
    },
  }
}

function gap(overrides: Partial<ShowGapResult['report']> = {}, recovered: unknown[] = []) {
  return {
    recovered,
    report: { shows_scanned: 12, missing: 0, saved: 0, by_show: {}, episodes: [], ...overrides },
  }
}

const cronRequest = () =>
  new Request('http://localhost/api/cron/spotify-sync', {
    headers: { authorization: 'Bearer test-310' },
  })
const browserRequest = () => new Request('http://localhost/api/cron/spotify-sync')

const successUpdate = () => mock.syncLogUpdates.find((u) => u.status === 'success')

beforeEach(() => {
  vi.clearAllMocks()
  mock.syncLogUpdates.length = 0
  process.env.SYNC_API_SECRET = 'test-310'
  mock.rpc.mockResolvedValue({ error: null })
  mock.episodes.mockResolvedValue([])
  mock.recover.mockResolvedValue(gap())
  mock.session.mockResolvedValue({ isAuthenticated: true })
  let created = 100
  mock.create.mockImplementation(async () => ({ contentItemId: created++, inserted: true }))
  mock.from.mockImplementation((table: string) =>
    table === 'sync_logs'
      ? chain({ id: 7 }, (payload) => mock.syncLogUpdates.push(payload))
      : chain([])
  )
})

describe('Spotify sync show-gap scan (#310)', () => {
  it('imports an episode the scan recovered on the cron run', async () => {
    const savedEp = saved('Ezra Klein', '2026-09-28')
    const recovered = saved('80,000 Hours', '2026-09-29', '2026-09-30T15:15:00Z')
    mock.episodes.mockResolvedValue([savedEp])
    mock.recover.mockResolvedValue(
      gap({ missing: 1, saved: 1, by_show: { '80,000 Hours': 1 } }, [recovered])
    )

    const res = await GET(cronRequest())
    const body = await res.json()

    expect(mock.recover).toHaveBeenCalledWith('token', [savedEp], expect.anything())
    const createdIds = mock.create.mock.calls.map(([item]) => item.externalId)
    expect(createdIds).toEqual([
      `spotify:episode:${savedEp.episode.id}`,
      `spotify:episode:${recovered.episode.id}`,
    ])
    expect(body).toMatchObject({ created: 2, showGap: { missing: 1, saved: 1 } })
  })

  it('skips the scan on browser-triggered syncs', async () => {
    const res = await GET(browserRequest())
    expect(res.status).toBe(200)
    expect(mock.recover).not.toHaveBeenCalled()
    expect(successUpdate()).not.toHaveProperty('metadata')
  })

  it('records the gap in sync_logs alongside the back-catalog skip', async () => {
    const backCatalog = Array.from({ length: BACK_CATALOG_MIN_SHOW_COUNT }, (_, i) =>
      saved('This American Life Partners', `${2000 + i}-01-01`)
    )
    mock.episodes.mockResolvedValue(backCatalog)
    const report = {
      shows_scanned: 12,
      missing: 2,
      saved: 0,
      by_show: { 'The Ezra Klein Show': 2 },
      episodes: [
        { show: 'The Ezra Klein Show', title: 'A' },
        { show: 'The Ezra Klein Show', title: 'B' },
      ],
      save_error: 'Spotify API error: Forbidden',
      save_status: 403,
    }
    mock.recover.mockResolvedValue({ recovered: [], report })

    await GET(cronRequest())

    expect(successUpdate()).toMatchObject({
      metadata: {
        trigger: 'cron',
        back_catalog_skipped: { total: BACK_CATALOG_MIN_SHOW_COUNT },
        show_gap: report,
      },
    })
  })

  it('leaves metadata alone when the scan found nothing', async () => {
    await GET(cronRequest())
    expect(mock.recover).toHaveBeenCalled()
    expect(successUpdate()).not.toHaveProperty('metadata')
  })

  it('does not alert on the expected 403 before the modify-scope re-auth', async () => {
    mock.recover.mockResolvedValue(
      gap({ missing: 1, save_error: 'Spotify API error: Forbidden', save_status: 403 })
    )
    await GET(cronRequest())
    expect(mock.logError).not.toHaveBeenCalled()
  })

  it('records per-show failures without alerting', async () => {
    mock.recover.mockResolvedValue(gap({ show_errors: ['Flaky Show: 404'] }))
    await GET(cronRequest())
    expect(mock.logError).not.toHaveBeenCalled()
    expect(successUpdate()).toMatchObject({
      metadata: { show_gap: { show_errors: ['Flaky Show: 404'] } },
    })
  })

  it('alerts on both a fatal scan error and an unexpected save failure in one run', async () => {
    mock.recover.mockResolvedValue(
      gap({
        scan_error: 'PostgrestError: timeout',
        save_error: 'SpotifyApiError: Spotify API error: Forbidden',
        save_status: 401,
      })
    )
    await GET(cronRequest())
    const messages = mock.logError.mock.calls.map(([, message]) => message)
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('timeout'),
        expect.stringContaining('Forbidden'),
      ])
    )
    expect(mock.logError).toHaveBeenCalledTimes(2)
  })

  it('alerts on an unexpected save failure or scan error', async () => {
    mock.recover.mockResolvedValue(
      gap({ missing: 1, save_error: 'Spotify API error: Unauthorized', save_status: 401 })
    )
    await GET(cronRequest())
    mock.recover.mockResolvedValue(gap({ scan_error: '1 show(s) failed: X: boom' }))
    await GET(cronRequest())

    expect(mock.logError).toHaveBeenCalledTimes(2)
    expect(mock.logError).toHaveBeenCalledWith(
      'spotify-sync',
      expect.stringContaining('Unauthorized'),
      expect.objectContaining({ blindSpot: 'show-gap-scan' })
    )
  })

  it('logs a Spotify 5xx save or scan failure at warn, not error (#342)', async () => {
    mock.recover.mockResolvedValue(
      gap({
        missing: 1,
        save_error: 'SpotifyApiError: Spotify API error: Bad Gateway',
        save_status: 502,
        scan_error: 'SpotifyApiError: Spotify API error: Gateway Timeout',
        scan_status: 504,
      })
    )
    await GET(cronRequest())

    expect(mock.logError).not.toHaveBeenCalled()
    expect(mock.logWarn).toHaveBeenCalledTimes(2)
    expect(mock.logWarn).toHaveBeenCalledWith(
      'spotify-sync',
      expect.stringContaining('Bad Gateway'),
      expect.objectContaining({ blindSpot: 'show-gap-scan', spotifyStatus: 502 })
    )
    expect(mock.logWarn).toHaveBeenCalledWith(
      'spotify-sync',
      expect.stringContaining('Gateway Timeout'),
      expect.objectContaining({ blindSpot: 'show-gap-scan', spotifyStatus: 504 })
    )
  })

  it('still completes the sync if the scan itself throws', async () => {
    const savedEp = saved('Ezra Klein', '2026-09-28')
    mock.episodes.mockResolvedValue([savedEp])
    mock.recover.mockRejectedValue(new Error('unexpected'))

    const res = await GET(cronRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ success: true, created: 1 })
    expect(successUpdate()).toMatchObject({
      metadata: { show_gap: { scan_error: 'Error: unexpected' } },
    })
  })
})
