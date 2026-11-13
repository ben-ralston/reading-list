/**
 * Unsaved queue episodes (#329): Spotify drops finished episodes from Your
 * Episodes, so /me/episodes alone can never report their completion. The
 * helper finds active queue items' Spotify episodes missing from the saved
 * list and fetches their resume points directly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SavedEpisode, SpotifyEpisode } from './client'

const mock = vi.hoisted(() => ({ fetchEpisodes: vi.fn() }))
vi.mock('./client', async (original) => ({
  ...(await original<typeof import('./client')>()),
  fetchEpisodes: mock.fetchEpisodes,
}))

import { fetchUnsavedQueueEpisodes, UNSAVED_PAGE_SIZE } from './unsaved-episodes'

function episode(id: string, fullyPlayed = false): SpotifyEpisode {
  return {
    id,
    name: `Episode ${id}`,
    duration_ms: 3_000_000,
    release_date: '2026-09-25',
    show: { id: 'show', name: 'Show' },
    external_urls: { spotify: `https://open.spotify.com/episode/${id}` },
    resume_point: { fully_played: fullyPlayed, resume_position_ms: 0 },
  }
}

const saved = (id: string): SavedEpisode => ({ added_at: '2026-09-25T22:00:00Z', episode: episode(id) })

/** Supabase stub: content_sources pages are served in order; calls are recorded. */
function sourcesClient(pages: Array<Array<{ external_id: string | null }>>) {
  const calls: Array<[string, unknown[]]> = []
  let page = 0
  const query: Record<string, unknown> = {}
  for (const name of ['select', 'eq', 'not', 'or', 'order']) {
    query[name] = vi.fn((...args: unknown[]) => {
      calls.push([name, args])
      return query
    })
  }
  query.range = vi.fn(async (...args: unknown[]) => {
    calls.push(['range', args])
    return { data: pages[page++] ?? [], error: null }
  })
  const client = { from: vi.fn(() => query) } as unknown as SupabaseClient
  return { client, calls }
}

beforeEach(() => {
  mock.fetchEpisodes.mockReset()
  mock.fetchEpisodes.mockImplementation(async (ids: string[]) => ids.map((id) => episode(id, true)))
})

describe('fetchUnsavedQueueEpisodes (#329)', () => {
  it('fetches active queue episodes that are missing from saved episodes', async () => {
    const { client } = sourcesClient([
      [
        { external_id: 'spotify:episode:savedOne' },
        { external_id: 'spotify:episode:5gR42c8UBHEINc5x9Wkgmc' },
      ],
    ])

    const result = await fetchUnsavedQueueEpisodes('token', [saved('savedOne')], client)

    expect(mock.fetchEpisodes).toHaveBeenCalledWith(['5gR42c8UBHEINc5x9Wkgmc'], 'token')
    expect(result.map((s) => s.episode.id)).toEqual(['5gR42c8UBHEINc5x9Wkgmc'])
    expect(result[0].episode.resume_point).toEqual({ fully_played: true, resume_position_ms: 0 })
  })

  it('only looks at Spotify sources of items still in the queue, excluding restored ones', async () => {
    const { client, calls } = sourcesClient([[]])

    await fetchUnsavedQueueEpisodes('token', [], client)

    expect(client.from).toHaveBeenCalledWith('content_sources')
    expect(calls).toContainEqual(['eq', ['platform', 'Spotify']])
    expect(calls).toContainEqual([
      'not',
      ['content_items.status', 'in', '("Completed","Skip","Awaiting comments")'],
    ])
    // A restored item's episode may still read fully played; resyncing it
    // would re-archive what the owner just put back (added_by is nullable).
    expect(calls).toContainEqual([
      'or',
      ['added_by.is.null,added_by.neq.Restored', { referencedTable: 'content_items' }],
    ])
  })

  it('ignores null, non-episode and duplicate external ids', async () => {
    const { client } = sourcesClient([
      [
        { external_id: null },
        { external_id: 'askwhocasts:abc' },
        { external_id: 'spotify:episode:dup' },
        { external_id: 'spotify:episode:dup' },
      ],
    ])

    await fetchUnsavedQueueEpisodes('token', [], client)

    expect(mock.fetchEpisodes).toHaveBeenCalledWith(['dup'], 'token')
  })

  it('makes no Spotify request when every queue episode is saved', async () => {
    const { client } = sourcesClient([[{ external_id: 'spotify:episode:savedOne' }]])

    const result = await fetchUnsavedQueueEpisodes('token', [saved('savedOne')], client)

    expect(result).toEqual([])
    expect(mock.fetchEpisodes).not.toHaveBeenCalled()
  })

  it('pages past the PostgREST row cap', async () => {
    const full = Array.from({ length: UNSAVED_PAGE_SIZE }, (_, i) => ({
      external_id: `spotify:episode:e${i}`,
    }))
    const { client, calls } = sourcesClient([full, [{ external_id: 'spotify:episode:last' }]])

    await fetchUnsavedQueueEpisodes('token', [], client)

    expect(calls.filter(([name]) => name === 'range')).toEqual([
      ['range', [0, UNSAVED_PAGE_SIZE - 1]],
      ['range', [UNSAVED_PAGE_SIZE, 2 * UNSAVED_PAGE_SIZE - 1]],
    ])
    expect(mock.fetchEpisodes.mock.calls[0][0]).toHaveLength(UNSAVED_PAGE_SIZE + 1)
  })

  it('throws when the source lookup fails', async () => {
    const query: Record<string, unknown> = {}
    for (const name of ['select', 'eq', 'not', 'or', 'order']) query[name] = vi.fn(() => query)
    query.range = vi.fn(async () => ({ data: null, error: { message: 'boom' } }))
    const client = { from: vi.fn(() => query) } as unknown as SupabaseClient

    await expect(fetchUnsavedQueueEpisodes('token', [], client)).rejects.toMatchObject({
      message: 'boom',
    })
  })
})
