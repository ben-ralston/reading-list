import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFrom = vi.fn()
vi.mock('@/lib/supabase', () => ({
  supabase: { from: (...a: unknown[]) => mockFrom(...a) },
}))

import {
  getDefaultBackfillDays,
  setDefaultBackfillDays,
  ALLOWED_BACKFILL_PRESETS,
  getEverythingLastSeen,
  setEverythingLastSeen,
} from './app-settings'

beforeEach(() => {
  mockFrom.mockReset()
})

describe('getDefaultBackfillDays', () => {
  it('returns the parsed integer when the row holds a preset value', async () => {
    mockFrom.mockReturnValue({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { value: '90' }, error: null }) }) }),
    })
    expect(await getDefaultBackfillDays()).toBe(90)
  })

  it('returns null when the row is absent', async () => {
    mockFrom.mockReturnValue({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
    })
    expect(await getDefaultBackfillDays()).toBeNull()
  })

  it('returns null when the stored value is unparseable', async () => {
    mockFrom.mockReturnValue({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { value: 'garbage' }, error: null }) }) }),
    })
    expect(await getDefaultBackfillDays()).toBeNull()
  })

  it('returns null on a Supabase error (fail-safe to off)', async () => {
    mockFrom.mockReturnValue({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    })
    expect(await getDefaultBackfillDays()).toBeNull()
  })
})

describe('setDefaultBackfillDays', () => {
  it('upserts the stringified value when given a preset', async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null })
    mockFrom.mockReturnValue({ upsert })
    await setDefaultBackfillDays(90)
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'default_backfill_days', value: '90' }),
    )
  })

  it('deletes the row when given null (off)', async () => {
    const eq = vi.fn().mockResolvedValue({ error: null })
    const del = vi.fn().mockReturnValue({ eq })
    mockFrom.mockReturnValue({ delete: del })
    await setDefaultBackfillDays(null)
    expect(del).toHaveBeenCalled()
    expect(eq).toHaveBeenCalledWith('key', 'default_backfill_days')
  })

  it('rejects a non-preset value', async () => {
    await expect(setDefaultBackfillDays(42)).rejects.toThrow()
  })
})

describe('ALLOWED_BACKFILL_PRESETS', () => {
  it('is the agreed preset set', () => {
    expect(ALLOWED_BACKFILL_PRESETS).toEqual([30, 90, 365])
  })
})

describe('Everything last-seen time (#377)', () => {
  const readReturning = (data: unknown, error: unknown = null) => {
    const eq = vi.fn(() => ({ maybeSingle: () => Promise.resolve({ data, error }) }))
    mockFrom.mockReturnValue({ select: () => ({ eq }) })
    return eq
  }

  it('reads the stored ISO time', async () => {
    const eq = readReturning({ value: '2026-11-09T12:00:00.000Z' })
    expect(await getEverythingLastSeen()).toBe('2026-11-09T12:00:00.000Z')
    expect(eq).toHaveBeenCalledWith('key', 'everything_last_seen_at')
  })

  it('returns null when absent, unparseable or on error', async () => {
    readReturning(null)
    expect(await getEverythingLastSeen()).toBeNull()
    readReturning({ value: 'garbage' })
    expect(await getEverythingLastSeen()).toBeNull()
    readReturning(null, { message: 'boom' })
    expect(await getEverythingLastSeen()).toBeNull()
  })

  // Reads the stored value, then upserts: one mock serves both calls.
  const store = (stored: string | null) => {
    const upsert = vi.fn().mockResolvedValue({ error: null })
    mockFrom.mockReturnValue({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: stored ? { value: stored } : null, error: null }) }) }),
      upsert,
    })
    return upsert
  }

  it('never moves the time backwards', async () => {
    const upsert = store('2026-11-09T12:00:00.000Z')
    await setEverythingLastSeen('2026-11-09T11:00:00.000Z', Date.parse('2026-11-09T13:00:00Z'))
    expect(upsert).not.toHaveBeenCalled()
  })

  it('upserts the given time', async () => {
    const upsert = store('2026-11-09T11:00:00.000Z')
    await setEverythingLastSeen('2026-11-09T12:00:00.000Z', Date.parse('2026-11-09T12:00:05Z'))
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ key: 'everything_last_seen_at', value: '2026-11-09T12:00:00.000Z' }))
  })

  it('clamps a future time to now', async () => {
    const upsert = store(null)
    const now = Date.parse('2026-11-09T12:00:00Z')
    await setEverythingLastSeen('2030-01-01T00:00:00.000Z', now)
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ value: new Date(now).toISOString() }))
  })

  it('rejects an unparseable time', async () => {
    await expect(setEverythingLastSeen('nope', Date.now())).rejects.toThrow()
  })
})
