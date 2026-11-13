import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { dismissContentItem, pinContentItem, restoreAndPinFeedItem } from './shortlist-writes'

function client(result: { data: unknown; error: unknown }) {
  const calls: Array<[string, unknown[]]> = []
  const chain: Record<string, unknown> = {}
  for (const m of ['update', 'eq', 'neq', 'in', 'select']) {
    chain[m] = vi.fn((...args: unknown[]) => { calls.push([m, args]); return chain })
  }
  chain.maybeSingle = vi.fn().mockResolvedValue(result)
  const from = vi.fn(() => chain)
  return { db: { from } as unknown as SupabaseClient, calls, from }
}

const row = { id: 7, title: 'X', author: 'Y', sources: [], kind: 'feed' }
const updateOf = (calls: Array<[string, unknown[]]>) =>
  calls.find(([m]) => m === 'update')?.[1][0] as Record<string, unknown>

describe('pinContentItem', () => {
  it('sets pinned_at, clears the dismissal, scoped to active feed rows', async () => {
    const { db, calls, from } = client({ data: row, error: null })
    expect(await pinContentItem(db, 7)).toEqual(row)
    expect(from).toHaveBeenCalledWith('content_items')
    const update = updateOf(calls)
    expect(typeof update.pinned_at).toBe('string')
    expect(update.shortlist_dismissed_at).toBeNull()
    expect(Object.keys(update).sort()).toEqual(['pinned_at', 'shortlist_dismissed_at'])
    expect(calls).toContainEqual(['eq', ['id', 7]])
    expect(calls).toContainEqual(['eq', ['kind', 'feed']])
    expect(calls).toContainEqual(['neq', ['status', 'Completed']])
    expect(calls).toContainEqual(['neq', ['status', 'Skip']])
  })

  it('returns null when no active feed row matched', async () => {
    const { db } = client({ data: null, error: null })
    expect(await pinContentItem(db, 7)).toBeNull()
  })

  it('throws on a database error', async () => {
    const { db } = client({ data: null, error: { message: 'boom' } })
    await expect(pinContentItem(db, 7)).rejects.toMatchObject({ message: 'boom' })
  })
})

describe('dismissContentItem', () => {
  it('clears pinned_at and sets shortlist_dismissed_at, scoped to active feed rows', async () => {
    const { db, calls } = client({ data: row, error: null })
    expect(await dismissContentItem(db, 7)).toEqual(row)
    const update = updateOf(calls)
    expect(update.pinned_at).toBeNull()
    expect(typeof update.shortlist_dismissed_at).toBe('string')
    expect(calls).toContainEqual(['eq', ['kind', 'feed']])
    expect(calls).toContainEqual(['neq', ['status', 'Completed']])
    expect(calls).toContainEqual(['neq', ['status', 'Skip']])
  })
})

describe('restoreAndPinFeedItem', () => {
  it('reactivates an archived feed row, marks it Restored and pins it', async () => {
    const { db, calls } = client({ data: row, error: null })
    expect(await restoreAndPinFeedItem(db, 7)).toEqual(row)
    const update = updateOf(calls)
    expect(update).toMatchObject({
      status: '',
      added_by: 'Restored',
      shortlist_dismissed_at: null,
      queue_position: null,
      position_confirmed: false,
    })
    expect(typeof update.pinned_at).toBe('string')
    expect(update.status_changed_at).toBe(update.pinned_at)
    expect(calls).toContainEqual(['in', ['status', ['Completed', 'Skip']]])
    expect(calls).toContainEqual(['eq', ['kind', 'feed']])
  })
})
