import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFrom = vi.fn()
const mockRpc = vi.fn()
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (...a: unknown[]) => mockFrom(...a),
    rpc: (...a: unknown[]) => mockRpc(...a),
  },
}))

import { delaySeconds, reserveSigninAttempt, resetSigninThrottle } from './signin-throttle'

type Result = { data: unknown; error: unknown }

/**
 * Wire the two supabase calls reserveSigninAttempt makes: the SELECT of the
 * singleton row, then the compare-and-swap UPDATE. Records every filter the
 * UPDATE applies so tests can assert the CAS guard.
 */
function wire(select: Result, update: Result | Result[] = { data: [{ id: 1 }], error: null }) {
  const updates = Array.isArray(update) ? [...update] : null
  const updateCalls: { values?: unknown; filters: [string, string, unknown][] } = { filters: [] }
  const updateChain = {
    eq: (col: string, val: unknown) => {
      updateCalls.filters.push(['eq', col, val])
      return updateChain
    },
    is: (col: string, val: unknown) => {
      updateCalls.filters.push(['is', col, val])
      return updateChain
    },
    select: () => Promise.resolve(updates ? (updates.length > 1 ? updates.shift()! : updates[0]) : update),
  }
  mockFrom.mockReturnValue({
    select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(select) }) }),
    update: (values: unknown) => {
      updateCalls.values = values
      return updateChain
    },
  })
  return updateCalls
}

function row(failedCount: number, lastFailedAgoSeconds: number | null) {
  return {
    failed_count: failedCount,
    last_failed_at:
      lastFailedAgoSeconds === null
        ? null
        : new Date(Date.now() - lastFailedAgoSeconds * 1000).toISOString(),
  }
}

beforeEach(() => {
  mockFrom.mockReset()
  mockRpc.mockReset()
})

describe('delaySeconds', () => {
  it('imposes no delay for the first 5 attempts', () => {
    expect(delaySeconds(0)).toBe(0)
    expect(delaySeconds(1)).toBe(0)
    expect(delaySeconds(4)).toBe(0)
  })

  it('backs off exponentially from 30s at the 5th failure', () => {
    expect(delaySeconds(5)).toBe(30)
    expect(delaySeconds(6)).toBe(60)
    expect(delaySeconds(7)).toBe(120)
    expect(delaySeconds(8)).toBe(240)
    expect(delaySeconds(9)).toBe(480)
  })

  it('caps at 900s (15 min)', () => {
    expect(delaySeconds(10)).toBe(900)
    expect(delaySeconds(50)).toBe(900)
  })
})

describe('reserveSigninAttempt', () => {
  it('allows with no recorded failures and reserves the attempt (count 1)', async () => {
    const calls = wire({ data: row(0, null), error: null })
    expect(await reserveSigninAttempt()).toEqual({ allowed: true })
    expect(calls.values).toMatchObject({ failed_count: 1 })
    // CAS guard: only applies if nobody else reserved since our read
    expect(calls.filters).toContainEqual(['eq', 'failed_count', 0])
    expect(calls.filters).toContainEqual(['is', 'last_failed_at', null])
  })

  it('allows below the free-attempt threshold and increments the count', async () => {
    const r = row(4, 1)
    const calls = wire({ data: r, error: null })
    expect(await reserveSigninAttempt()).toEqual({ allowed: true })
    expect(calls.values).toMatchObject({ failed_count: 5 })
    expect(calls.filters).toContainEqual(['eq', 'failed_count', 4])
    expect(calls.filters).toContainEqual(['eq', 'last_failed_at', r.last_failed_at])
  })

  it('retries after losing the compare-and-swap, so a double-submit is not a false lockout', async () => {
    wire({ data: row(0, null), error: null }, [
      { data: [], error: null },
      { data: [{ id: 1 }], error: null },
    ])
    expect(await reserveSigninAttempt()).toEqual({ allowed: true })
  })

  it('denies an attempt that keeps losing the compare-and-swap (F1/F4 race)', async () => {
    wire({ data: row(0, null), error: null }, { data: [], error: null })
    const gate = await reserveSigninAttempt()
    expect(gate.allowed).toBe(false)
    if (!gate.allowed) expect(gate.retryAfterSeconds).toBeGreaterThanOrEqual(1)
  })

  it('denies with a retry time while inside the backoff window, without reserving', async () => {
    const calls = wire({ data: row(5, 2), error: null }) // 30s window, 2s elapsed
    const gate = await reserveSigninAttempt()
    expect(gate.allowed).toBe(false)
    if (!gate.allowed) {
      expect(gate.retryAfterSeconds).toBeGreaterThan(20)
      expect(gate.retryAfterSeconds).toBeLessThanOrEqual(30)
    }
    expect(calls.values).toBeUndefined()
  })

  it('allows once the backoff window has elapsed', async () => {
    const calls = wire({ data: row(5, 35), error: null })
    expect(await reserveSigninAttempt()).toEqual({ allowed: true })
    expect(calls.values).toMatchObject({ failed_count: 6 })
  })

  it('restarts the count at 1 when the last failure is stale', async () => {
    const calls = wire({ data: row(12, 2 * 60 * 60), error: null }) // 2h old
    expect(await reserveSigninAttempt()).toEqual({ allowed: true })
    expect(calls.values).toMatchObject({ failed_count: 1 })
  })

  it('creates a missing singleton row and reserves on the retry, never allowing uncounted', async () => {
    const upsert = vi.fn().mockResolvedValue({ data: null, error: null })
    let reads = 0
    mockFrom.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve(reads++ === 0 ? { data: null, error: null } : { data: row(0, null), error: null }),
        }),
      }),
      upsert,
      update: () => {
        const chain: any = { eq: () => chain, is: () => chain, select: () => Promise.resolve({ data: [{ id: 1 }], error: null }) }
        return chain
      },
    }))
    expect(await reserveSigninAttempt()).toEqual({ allowed: true })
    expect(upsert).toHaveBeenCalledWith({ id: 1 }, expect.objectContaining({ ignoreDuplicates: true }))
    expect(reads).toBe(2)
  })

  it('fails open (with a logged error) on a DB read error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    wire({ data: null, error: { message: 'connection refused' } })
    expect(await reserveSigninAttempt()).toEqual({ allowed: true })
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('fails open (with a logged error) on a DB update error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    wire({ data: row(0, null), error: null }, { data: null, error: { message: 'boom' } })
    expect(await reserveSigninAttempt()).toEqual({ allowed: true })
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})

describe('resetSigninThrottle', () => {
  it('calls the reset RPC', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null })
    await resetSigninThrottle()
    expect(mockRpc).toHaveBeenCalledWith('reset_signin_throttle')
  })

  it('does not throw on RPC errors (logged)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockRpc.mockResolvedValue({ data: null, error: { message: 'boom' } })
    await expect(resetSigninThrottle()).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
