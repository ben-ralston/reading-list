/**
 * Show-gap scan (#310): Spotify's auto-download silently skips some new
 * episodes of followed shows, so they never reach /me/episodes and never
 * reach the queue. The scan finds recent episodes of followed shows that are
 * missing from saved episodes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  fetchSavedShows,
  fetchShowEpisodePages,
  saveToLibrary,
  SpotifyApiError,
  type SavedEpisode,
  type SavedShow,
  type ShowEpisode,
} from './client'
import {
  emptyShowGapReport,
  recoverShowGaps,
  selectMissingEpisodes,
  SHOW_GAP_EPISODES_PER_SHOW,
  SHOW_GAP_LOOKBACK_DAYS,
} from './show-gaps'

vi.mock('./client', async (original) => ({
  ...(await original<typeof import('./client')>()),
  fetchSavedShows: vi.fn(),
  fetchShowEpisodePages: vi.fn(),
  saveToLibrary: vi.fn(),
}))

const NOW = new Date('2026-09-30T15:00:00Z')

function show(id: string, followedAt = '2025-01-01T00:00:00Z'): SavedShow {
  return { added_at: followedAt, show: { id, name: `Show ${id}` } }
}

function ep(id: string, release: string): ShowEpisode {
  return {
    id,
    name: `Episode ${id}`,
    duration_ms: 1_800_000,
    release_date: release,
    external_urls: { spotify: `https://open.spotify.com/episode/${id}` },
  }
}

function select(
  shows: SavedShow[],
  episodes: Record<string, ShowEpisode[]>,
  savedIds: string[] = []
) {
  return selectMissingEpisodes(shows, new Map(Object.entries(episodes)), new Set(savedIds), NOW)
    .map((c) => c.episode.id)
}

describe('selectMissingEpisodes', () => {
  it('picks a recent episode that is not saved', () => {
    expect(select([show('s')], { s: [ep('new', '2026-09-28')] })).toEqual(['new'])
  })

  it('carries the show the episode belongs to', () => {
    const [candidate] = selectMissingEpisodes(
      [show('s')],
      new Map([['s', [ep('new', '2026-09-28')]]]),
      new Set(),
      NOW
    )
    expect(candidate.show).toEqual({ id: 's', name: 'Show s' })
  })

  it('skips episodes that are already saved', () => {
    expect(select([show('s')], { s: [ep('saved', '2026-09-28')] }, ['saved'])).toEqual([])
  })

  it(`keeps the last ${SHOW_GAP_LOOKBACK_DAYS} days and drops anything older`, () => {
    // NOW is 2026-09-30, so the window starts 2026-09-23.
    const episodes = [ep('edge', '2026-09-23'), ep('old', '2026-09-22'), ep('today', '2026-09-30')]
    expect(select([show('s')], { s: episodes })).toEqual(['edge', 'today'])
  })

  it('drops episodes released before the show was followed (no archive on follow)', () => {
    const followed = show('s', '2026-09-27T18:00:00Z')
    const episodes = [ep('before', '2026-09-26'), ep('same-day', '2026-09-27'), ep('after', '2026-09-29')]
    expect(select([followed], { s: episodes })).toEqual(['same-day', 'after'])
  })

  it('drops episodes without a full YYYY-MM-DD release date', () => {
    const episodes = [ep('month', '2026-09'), ep('year', '2026'), ep('blank', '')]
    expect(select([show('s')], { s: episodes })).toEqual([])
  })

  it('handles shows with no fetched episodes', () => {
    expect(select([show('a'), show('b')], { b: [ep('x', '2026-09-29')] })).toEqual(['x'])
  })
})

describe('recoverShowGaps', () => {
  const token = 'tok'

  function supabaseWithKnown(externalIds: string[], error: { message: string } | null = null) {
    const inFn = vi.fn(async () => ({
      data: error ? null : externalIds.map((external_id) => ({ external_id })),
      error,
    }))
    const query = { select: vi.fn(() => query), in: inFn }
    return { client: { from: vi.fn(() => query) } as unknown as SupabaseClient, inFn }
  }

  function pagesFor(byShow: Record<string, ShowEpisode[] | Error>) {
    return (showId: string) =>
      (async function* () {
        const value = byShow[showId] ?? []
        if (value instanceof Error) throw value
        yield value
      })()
  }

  beforeEach(() => {
    vi.mocked(fetchSavedShows).mockReset()
    vi.mocked(fetchShowEpisodePages).mockReset()
    vi.mocked(saveToLibrary).mockReset().mockResolvedValue(undefined)
  })

  it('saves missing episodes and returns them as saved episodes with show and progress', async () => {
    vi.mocked(fetchSavedShows).mockResolvedValue([show('s')])
    const missing = { ...ep('m', '2026-09-29'), resume_point: { fully_played: false, resume_position_ms: 5000 } }
    vi.mocked(fetchShowEpisodePages).mockImplementation(pagesFor({ s: [missing, ep('saved', '2026-09-29')] }))
    const { client } = supabaseWithKnown([])
    const savedList = [{ added_at: '2026-09-29T10:00:00Z', episode: { id: 'saved' } }] as SavedEpisode[]

    const { recovered, report } = await recoverShowGaps(token, savedList, client, NOW)

    expect(saveToLibrary).toHaveBeenCalledWith(token, ['spotify:episode:m'])
    expect(recovered).toHaveLength(1)
    expect(recovered[0].added_at).toBe(NOW.toISOString())
    expect(recovered[0].episode).toMatchObject({
      id: 'm',
      show: { id: 's', name: 'Show s' },
      resume_point: { resume_position_ms: 5000 },
    })
    expect(report).toMatchObject({
      shows_scanned: 1,
      missing: 1,
      saved: 1,
      by_show: { 'Show s': 1 },
      episodes: [{ show: 'Show s', title: 'Episode m' }],
    })
  })

  it('requests only the newest page per show', async () => {
    vi.mocked(fetchSavedShows).mockResolvedValue([show('s')])
    vi.mocked(fetchShowEpisodePages).mockImplementation(pagesFor({ s: [] }))
    await recoverShowGaps(token, [], supabaseWithKnown([]).client, NOW)
    expect(fetchShowEpisodePages).toHaveBeenCalledWith('s', token, { limit: SHOW_GAP_EPISODES_PER_SHOW })
  })

  it('does not re-save episodes already imported into the queue', async () => {
    vi.mocked(fetchSavedShows).mockResolvedValue([show('s')])
    vi.mocked(fetchShowEpisodePages).mockImplementation(
      pagesFor({ s: [ep('known', '2026-09-29'), ep('new', '2026-09-29')] })
    )
    const { client, inFn } = supabaseWithKnown(['spotify:episode:known'])

    const { recovered, report } = await recoverShowGaps(token, [], client, NOW)

    expect(inFn).toHaveBeenCalledWith('external_id', ['spotify:episode:known', 'spotify:episode:new'])
    expect(saveToLibrary).toHaveBeenCalledWith(token, ['spotify:episode:new'])
    expect(recovered.map((r) => r.episode.id)).toEqual(['new'])
    expect(report.missing).toBe(1)
  })

  it('makes no save call when nothing is missing', async () => {
    vi.mocked(fetchSavedShows).mockResolvedValue([show('s')])
    vi.mocked(fetchShowEpisodePages).mockImplementation(pagesFor({ s: [ep('old', '2026-01-01')] }))
    const { recovered, report } = await recoverShowGaps(token, [], supabaseWithKnown([]).client, NOW)
    expect(saveToLibrary).not.toHaveBeenCalled()
    expect(recovered).toEqual([])
    expect(report).toMatchObject({ missing: 0, saved: 0 })
  })

  it('imports nothing and reports the failure when the save is refused (no modify scope yet)', async () => {
    vi.mocked(fetchSavedShows).mockResolvedValue([show('s')])
    vi.mocked(fetchShowEpisodePages).mockImplementation(pagesFor({ s: [ep('m', '2026-09-29')] }))
    vi.mocked(saveToLibrary).mockRejectedValue(new SpotifyApiError('Spotify API error: Forbidden', 403))

    const { recovered, report } = await recoverShowGaps(token, [], supabaseWithKnown([]).client, NOW)

    expect(recovered).toEqual([])
    expect(report).toMatchObject({
      missing: 1,
      saved: 0,
      save_status: 403,
      save_error: 'SpotifyApiError: Spotify API error: Forbidden',
      episodes: [{ show: 'Show s', title: 'Episode m' }],
    })
  })

  it('keeps scanning the other shows when one show fails', async () => {
    vi.mocked(fetchSavedShows).mockResolvedValue([show('bad'), show('good')])
    vi.mocked(fetchShowEpisodePages).mockImplementation(
      pagesFor({ bad: new Error('boom'), good: [ep('g', '2026-09-29')] })
    )
    const { recovered, report } = await recoverShowGaps(token, [], supabaseWithKnown([]).client, NOW)
    expect(recovered.map((r) => r.episode.id)).toEqual(['g'])
    // A per-show failure is partial: recorded, but not the fatal scan_error
    // that alerts (one flaky show must not page every hour).
    expect(report.show_errors).toEqual(['Show bad: Error: boom'])
    expect(report.scan_error).toBeUndefined()
  })

  it('never throws: a failed show listing becomes scan_error', async () => {
    vi.mocked(fetchSavedShows).mockRejectedValue(new SpotifyApiError('Spotify API error: Bad Gateway', 502))
    const { recovered, report } = await recoverShowGaps(token, [], supabaseWithKnown([]).client, NOW)
    expect(recovered).toEqual([])
    expect(report.scan_error).toBe('SpotifyApiError: Spotify API error: Bad Gateway')
    // The status lets the route log an upstream 5xx at warn (#342).
    expect(report.scan_status).toBe(502)
    expect(saveToLibrary).not.toHaveBeenCalled()
  })

  it('saves nothing when the known-episode lookup fails (cannot rule out re-saving)', async () => {
    vi.mocked(fetchSavedShows).mockResolvedValue([show('s')])
    vi.mocked(fetchShowEpisodePages).mockImplementation(pagesFor({ s: [ep('m', '2026-09-29')] }))
    const { client } = supabaseWithKnown([], { message: 'timeout' })
    const { recovered, report } = await recoverShowGaps(token, [], client, NOW)
    expect(saveToLibrary).not.toHaveBeenCalled()
    expect(recovered).toEqual([])
    expect(report.scan_error).toBe('timeout')
  })

  it('caps the reported episode list at 20', async () => {
    vi.mocked(fetchSavedShows).mockResolvedValue([show('s')])
    const many = Array.from({ length: 25 }, (_, i) => ep(`e${i}`, '2026-09-29'))
    vi.mocked(fetchShowEpisodePages).mockImplementation(pagesFor({ s: many }))
    const { report } = await recoverShowGaps(token, [], supabaseWithKnown([]).client, NOW)
    expect(report.missing).toBe(25)
    expect(report.episodes).toHaveLength(20)
  })
})

describe('recoverShowGaps partial save (#310 review)', () => {
  beforeEach(() => {
    vi.mocked(fetchSavedShows).mockReset()
    vi.mocked(fetchShowEpisodePages).mockReset()
    vi.mocked(saveToLibrary).mockReset()
  })

  it('keeps the batches that saved when a later batch fails', async () => {
    vi.mocked(fetchSavedShows).mockResolvedValue([show('s')])
    const many = Array.from({ length: 45 }, (_, i) => ep(`e${i}`, '2026-09-29'))
    vi.mocked(fetchShowEpisodePages).mockImplementation(() =>
      (async function* () {
        yield many
      })()
    )
    vi.mocked(saveToLibrary)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new SpotifyApiError('Spotify API error: Server Error', 500))
    const query = {
      select: vi.fn(() => query),
      in: vi.fn(async () => ({ data: [], error: null })),
    }
    const client = { from: vi.fn(() => query) } as unknown as SupabaseClient

    const { recovered, report } = await recoverShowGaps('tok', [], client, NOW)

    expect(vi.mocked(saveToLibrary).mock.calls.map(([, uris]) => uris.length)).toEqual([40, 5])
    expect(recovered).toHaveLength(40)
    expect(report).toMatchObject({ missing: 45, saved: 40, save_status: 500 })
  })
})

describe('emptyShowGapReport', () => {
  it('is a zeroed report with fresh collections each call', () => {
    const a = emptyShowGapReport()
    a.by_show.x = 1
    expect(emptyShowGapReport()).toEqual({
      shows_scanned: 0,
      missing: 0,
      saved: 0,
      by_show: {},
      episodes: [],
    })
  })
})
