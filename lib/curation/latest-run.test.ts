import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchLatestCuration } from './latest-run'

function clientReturning(result: { data: unknown; error: unknown }) {
  const calls: Array<[string, unknown[]]> = []
  const chain: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'order', 'limit']) {
    chain[method] = vi.fn((...args: unknown[]) => {
      calls.push([method, args])
      return chain
    })
  }
  chain.maybeSingle = vi.fn().mockResolvedValue(result)
  const from = vi.fn(() => chain)
  return { client: { from } as unknown as SupabaseClient, calls, from }
}

describe('fetchLatestCuration', () => {
  it('returns parsed picks and finishedAt from the latest succeeded row', async () => {
    const { client, calls, from } = clientReturning({
      data: { finished_at: '2026-11-09T21:45:00Z', picks: [{ id: 5, reason: 'New episode' }, { id: 'bad' }, { id: 7 }] },
      error: null,
    })
    expect(await fetchLatestCuration(client)).toEqual({
      finishedAt: '2026-11-09T21:45:00Z',
      picks: [{ id: 5, reason: 'New episode' }, { id: 7, reason: null }],
    })
    expect(from).toHaveBeenCalledWith('curation_runs')
    expect(calls).toContainEqual(['eq', ['status', 'succeeded']])
    expect(calls).toContainEqual(['order', ['finished_at', { ascending: false }]])
    expect(calls).toContainEqual(['limit', [1]])
  })

  it('returns null when the query errors, without throwing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client } = clientReturning({ data: null, error: { message: 'relation does not exist' } })
    expect(await fetchLatestCuration(client)).toBeNull()
    spy.mockRestore()
  })

  it('returns null when there is no succeeded run', async () => {
    const { client } = clientReturning({ data: null, error: null })
    expect(await fetchLatestCuration(client)).toBeNull()
  })

  it('returns null when the client itself throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const client = { from: () => { throw new Error('network') } } as unknown as SupabaseClient
    expect(await fetchLatestCuration(client)).toBeNull()
    spy.mockRestore()
  })
})
