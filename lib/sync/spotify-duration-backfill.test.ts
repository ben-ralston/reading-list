import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  findItemsNeedingDuration,
  fillOneDuration,
  type DurationRow,
} from './spotify-duration-backfill'
import * as client from '@/lib/spotify/client'

// Minimal supabase fake recording content_items.update({...}).eq('id', id).is(col, val)
function makeSupabase() {
  const updates: { payload: Record<string, unknown>; id: unknown; nullGuard: boolean }[] = []
  const supabase = {
    from(table: string) {
      expect(table).toBe('content_items')
      return {
        update(payload: Record<string, unknown>) {
          const call = { payload, id: undefined as unknown, nullGuard: false }
          const chain = {
            eq(_col: string, id: unknown) {
              call.id = id
              return chain
            },
            is(col: string, val: unknown) {
              if (col === 'duration_seconds' && val === null) call.nullGuard = true
              updates.push(call)
              return Promise.resolve({ error: null })
            },
          }
          return chain
        },
      }
    },
  } as unknown as SupabaseClient
  return { supabase, updates }
}

const ROW: DurationRow = { contentItemId: 42, title: 'Some Episode', episodeId: 'abc123' }

describe('fillOneDuration', () => {
  beforeEach(() => {
    vi.spyOn(client, 'fetchEpisode')
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes duration_seconds with a NULL guard when the episode resolves', async () => {
    vi.mocked(client.fetchEpisode).mockResolvedValue({ duration_ms: 3661000 })
    const { supabase, updates } = makeSupabase()

    const result = await fillOneDuration(ROW, 'token', supabase, { dryRun: false })

    expect(result).toMatchObject({ contentItemId: 42, action: 'filled', durationSeconds: 3661 })
    expect(updates).toHaveLength(1)
    expect(updates[0]).toEqual({ payload: { duration_seconds: 3661 }, id: 42, nullGuard: true })
  })

  it('does not write in dry-run mode', async () => {
    vi.mocked(client.fetchEpisode).mockResolvedValue({ duration_ms: 3661000 })
    const { supabase, updates } = makeSupabase()

    const result = await fillOneDuration(ROW, 'token', supabase, { dryRun: true })

    expect(result.action).toBe('filled')
    expect(updates).toHaveLength(0)
  })

  it('returns episode-not-found and writes nothing when the episode 404s', async () => {
    vi.mocked(client.fetchEpisode).mockResolvedValue(null)
    const { supabase, updates } = makeSupabase()

    const result = await fillOneDuration(ROW, 'token', supabase, { dryRun: false })

    expect(result.action).toBe('episode-not-found')
    expect(updates).toHaveLength(0)
  })

  it('returns failed instead of throwing when the API call throws', async () => {
    vi.mocked(client.fetchEpisode).mockRejectedValue(new Error('boom'))
    const { supabase, updates } = makeSupabase()

    const result = await fillOneDuration(ROW, 'token', supabase, { dryRun: false })

    expect(result.action).toBe('failed')
    expect(updates).toHaveLength(0)
  })

  it('waits out a 429 Retry-After and retries once (observed: bulk runs trip rate limiting)', async () => {
    vi.mocked(client.fetchEpisode)
      .mockRejectedValueOnce(new client.SpotifyApiError('rate limited', 429, 2))
      .mockResolvedValueOnce({ duration_ms: 60000 })
    const sleep = vi.fn().mockResolvedValue(undefined)
    const { supabase, updates } = makeSupabase()

    const result = await fillOneDuration(ROW, 'token', supabase, { dryRun: false, sleep })

    expect(sleep).toHaveBeenCalledWith(2000)
    expect(result.action).toBe('filled')
    expect(updates).toHaveLength(1)
  })

  it('does not sleep on a non-numeric Retry-After (HTTP-date parses to NaN)', async () => {
    vi.mocked(client.fetchEpisode).mockRejectedValue(
      new client.SpotifyApiError('rate limited', 429, Number.NaN)
    )
    const sleep = vi.fn().mockResolvedValue(undefined)
    const { supabase, updates } = makeSupabase()

    const result = await fillOneDuration(ROW, 'token', supabase, { dryRun: false, sleep })

    expect(sleep).not.toHaveBeenCalled()
    expect(result.action).toBe('failed')
    expect(updates).toHaveLength(0)
  })

  it('returns failed when the retry after a 429 also fails', async () => {
    vi.mocked(client.fetchEpisode).mockRejectedValue(
      new client.SpotifyApiError('rate limited', 429, 1)
    )
    const sleep = vi.fn().mockResolvedValue(undefined)
    const { supabase, updates } = makeSupabase()

    const result = await fillOneDuration(ROW, 'token', supabase, { dryRun: false, sleep })

    expect(sleep).toHaveBeenCalledTimes(1) // one retry, not a loop
    expect(result.action).toBe('failed')
    expect(updates).toHaveLength(0)
  })

  it('returns failed when the DB update errors', async () => {
    vi.mocked(client.fetchEpisode).mockResolvedValue({ duration_ms: 1000 })
    const supabase = {
      from() {
        return {
          update() {
            const chain = {
              eq: () => chain,
              is: () => Promise.resolve({ error: { message: 'db down' } }),
            }
            return chain
          },
        }
      },
    } as unknown as SupabaseClient

    const result = await fillOneDuration(ROW, 'token', supabase, { dryRun: false })

    expect(result.action).toBe('failed')
  })
})

describe('findItemsNeedingDuration', () => {
  it('maps rows, strips the external_id prefix, and dedupes by content item', async () => {
    const data = [
      {
        external_id: 'spotify:episode:aaa',
        content_item_id: 1,
        content_items: { id: 1, title: 'One', duration_seconds: null },
      },
      {
        external_id: 'spotify:episode:aaa-dup',
        content_item_id: 1,
        content_items: { id: 1, title: 'One', duration_seconds: null },
      },
      {
        external_id: 'spotify:episode:bbb',
        content_item_id: 2,
        content_items: { id: 2, title: 'Two', duration_seconds: null },
      },
    ]
    const supabase = {
      from(table: string) {
        expect(table).toBe('content_sources')
        const chain = {
          select: () => chain,
          eq: () => chain,
          like: () => chain,
          is: () => chain,
          order: () => Promise.resolve({ data, error: null }),
          limit: () => Promise.resolve({ data, error: null }),
        }
        return chain
      },
    } as unknown as SupabaseClient

    const rows = await findItemsNeedingDuration(supabase)

    expect(rows).toEqual([
      { contentItemId: 1, title: 'One', episodeId: 'aaa' },
      { contentItemId: 2, title: 'Two', episodeId: 'bbb' },
    ])
  })
})
