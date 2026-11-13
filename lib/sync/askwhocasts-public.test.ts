import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  parsePublicEpisodes,
  stripEpisodeDecoration,
  matchPublicEpisode,
  externalIdForEpisode,
  syncPublicEpisodes,
} from './askwhocasts-public'
import type { ShowEpisode } from '@/lib/spotify/client'

vi.mock('@/lib/spotify/client', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/spotify/client')>()
  return { ...mod, fetchShowEpisodePages: vi.fn() }
})
import { fetchShowEpisodePages } from '@/lib/spotify/client'
const fetchPagesMock = vi.mocked(fetchShowEpisodePages)

const EP = (id: string, name: string): ShowEpisode => ({
  id,
  name,
  duration_ms: 1000,
  release_date: '2026-07-18',
  external_urls: { spotify: `https://open.spotify.com/episode/${id}` },
})

async function* pagesOf(...pages: ShowEpisode[][]) {
  for (const p of pages) yield p
}

describe('externalIdForEpisode', () => {
  it('uses the spotify-sync convention', () => {
    expect(externalIdForEpisode('abc')).toBe('spotify:episode:abc')
  })
})

describe('stripEpisodeDecoration', () => {
  it.each([
    ['Why kinship societies kill their old - By David Oks', 'Why kinship societies kill their old'],
    ['Losing the War - by Lee Sandlin', 'Losing the War'],
    ['Colder Wars, By Gwern', 'Colder Wars'],
    ['What Should Be Done- By Dean W. Ball', 'What Should Be Done'],
    [
      'Your Book Review: Great And Desperate Cures - ACX Book Review',
      'Your Book Review: Great And Desperate Cures',
    ],
    ['Introducing Plan A - By Scott Alexander', 'Introducing Plan A'],
  ])('strips %s', (input, expected) => {
    expect(stripEpisodeDecoration(input)).toBe(expected)
  })

  it('strips only the LAST attribution for multi-attribution titles', () => {
    expect(
      stripEpisodeDecoration('JOINT REVIEW: Starting Strength, by Mark Rippetoe, By John Psmith')
    ).toBe('JOINT REVIEW: Starting Strength, by Mark Rippetoe')
  })

  it('leaves undecorated titles and leading-By titles alone', () => {
    expect(stripEpisodeDecoration('Waiting For The Miracle')).toBe('Waiting For The Miracle')
    expect(stripEpisodeDecoration('By the River')).toBe('By the River')
  })
})

describe('parsePublicEpisodes', () => {
  it('drops episodes missing id, name, or link', () => {
    const good = EP('a', 'Good')
    const noLink = { ...EP('b', 'NoLink'), external_urls: { spotify: '' } }
    expect(parsePublicEpisodes([good, noLink])).toEqual([
      { id: 'a', title: 'Good', link: 'https://open.spotify.com/episode/a' },
    ])
  })
})

describe('matchPublicEpisode', () => {
  const candidates = [
    { id: 1, title: 'Why kinship societies kill their old', author: 'David Oks' },
    { id: 2, title: 'Introducing Plan A', author: 'Astral Codex Ten' },
    { id: 3, title: 'Introducing Plan A', author: 'Someone Else' },
  ]

  it('matches a decorated title to exactly one item', () => {
    expect(matchPublicEpisode('Why kinship societies kill their old - By David Oks', candidates)).toBe(1)
  })

  it('returns null when the stripped title matches multiple items', () => {
    expect(matchPublicEpisode('Introducing Plan A - By Scott Alexander', candidates)).toBeNull()
  })

  it('returns null when nothing matches', () => {
    expect(matchPublicEpisode('Some Unrelated Episode - By Nobody', candidates)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// syncPublicEpisodes — chainable supabase mock covering the two query shapes
// (content_sources known-ids page, content_items candidates page) + insert spy.
// ---------------------------------------------------------------------------

function createMockSupabase(options: {
  knownExternalIds?: string[]
  contentItems?: { id: number; title: string; author: string }[]
  insertResults?: { error: { code: string; message: string } | null }[]
}) {
  const { knownExternalIds = [], contentItems = [], insertResults = [{ error: null }] } = options
  const insert = vi.fn()
  for (const result of insertResults) {
    insert.mockResolvedValueOnce(result)
  }
  insert.mockResolvedValue({ error: null })

  const from = vi.fn().mockImplementation((table: string) => {
    if (table === 'content_sources') {
      return {
        insert,
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            like: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnValue({
                range: vi.fn().mockImplementation((fromIdx: number, toIdx: number) => {
                  const rows = knownExternalIds.map((external_id) => ({ external_id }))
                  return Promise.resolve({ data: rows.slice(fromIdx, toIdx + 1), error: null })
                }),
              }),
            }),
          }),
        }),
      }
    }
    if (table === 'content_items') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              range: vi.fn().mockImplementation((fromIdx: number, toIdx: number) =>
                Promise.resolve({ data: contentItems.slice(fromIdx, toIdx + 1), error: null })
              ),
            }),
          }),
        }),
      }
    }
    throw new Error(`Unexpected table ${table}`)
  })

  return { supabase: { from } as unknown as SupabaseClient, insert }
}

describe('syncPublicEpisodes', () => {
  beforeEach(() => fetchPagesMock.mockReset())

  it('attaches a matching new episode with spotify-sync conventions', async () => {
    fetchPagesMock.mockReturnValue(
      pagesOf([EP('ep1', 'Why kinship societies kill their old - By David Oks')])
    )
    const { supabase, insert } = createMockSupabase({
      contentItems: [{ id: 42, title: 'Why kinship societies kill their old', author: 'David Oks' }],
    })
    const result = await syncPublicEpisodes('token', supabase)
    expect(insert).toHaveBeenCalledWith({
      content_item_id: 42,
      platform: 'Spotify',
      link: 'https://open.spotify.com/episode/ep1',
      external_id: 'spotify:episode:ep1',
      is_primary: false,
      // #245: these all come from the pinned "AI Article Readings" show, so the
      // label is a constant that distinguishes them from a human-narrated episode.
      source_label: 'AI Article Readings',
    })
    expect(result).toMatchObject({ processed: 1, attached: 1, skipped: 0, itemErrors: 0 })
    expect(result.unmatched).toEqual([])
  })

  it('skips already-known episodes and early-stops on a fully-known page', async () => {
    fetchPagesMock.mockReturnValue(
      pagesOf(
        [EP('known1', 'Anything - By Anyone')],
        [EP('old1', 'Should not be fetched')] // must never be reached
      )
    )
    const { supabase, insert } = createMockSupabase({ knownExternalIds: ['spotify:episode:known1'] })
    const result = await syncPublicEpisodes('token', supabase)
    expect(result).toMatchObject({ processed: 1, attached: 0, skipped: 1 })
    expect(insert).not.toHaveBeenCalled()
  })

  it('reports unmatched episodes without inserting', async () => {
    fetchPagesMock.mockReturnValue(pagesOf([EP('ep2', 'Some Unmatched Episode - By Nobody')]))
    const { supabase, insert } = createMockSupabase({ contentItems: [] })
    const result = await syncPublicEpisodes('token', supabase)
    expect(insert).not.toHaveBeenCalled()
    expect(result.unmatched).toEqual([
      { title: 'Some Unmatched Episode - By Nobody', link: 'https://open.spotify.com/episode/ep2' },
    ])
  })

  it('treats a 23505 insert race as skipped, not an error', async () => {
    fetchPagesMock.mockReturnValue(
      pagesOf([EP('ep3', 'Why kinship societies kill their old - By David Oks')])
    )
    const { supabase } = createMockSupabase({
      contentItems: [{ id: 42, title: 'Why kinship societies kill their old', author: 'David Oks' }],
      insertResults: [{ error: { code: '23505', message: 'duplicate key' } }],
    })
    const result = await syncPublicEpisodes('token', supabase)
    expect(result).toMatchObject({ attached: 0, skipped: 1, itemErrors: 0 })
  })

  it('counts per-episode insert failures as itemErrors and continues', async () => {
    fetchPagesMock.mockReturnValue(
      pagesOf([
        EP('bad', 'Why kinship societies kill their old - By David Oks'),
        EP('good', 'Introducing Plan A - By Scott Alexander'),
      ])
    )
    const { supabase, insert } = createMockSupabase({
      contentItems: [
        { id: 42, title: 'Why kinship societies kill their old', author: 'David Oks' },
        { id: 43, title: 'Introducing Plan A', author: 'Astral Codex Ten' },
      ],
      insertResults: [{ error: { code: '500', message: 'boom' } }, { error: null }],
    })
    const result = await syncPublicEpisodes('token', supabase)
    expect(insert).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ attached: 1, itemErrors: 1 })
  })
})
