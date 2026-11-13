// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { createFailureStreak, isTransientNetworkError } from './failure-streak'

const MIN = 60_000

function setup() {
  let now = Date.parse('2026-11-06T03:32:00Z')
  const ulog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const streak = createFailureStreak({
    ulog,
    nowMs: () => now,
    failedMessage: 'awc claim failed',
    recoveredMessage: 'awc claim recovered',
  })
  return { ulog, streak, advance: (ms: number) => { now += ms } }
}

// Fail every `stepMs` for `totalMs`, as the claim loop (5 s) or heartbeat (60 s) would.
function failFor(s: ReturnType<typeof setup>, totalMs: number, stepMs: number) {
  let last = s.streak.fail({ error: 'x' })
  for (let t = stepMs; t <= totalMs; t += stepMs) {
    s.advance(stepMs)
    last = s.streak.fail({ error: 'x' })
  }
  return last
}

describe('failure streak (#366)', () => {
  it('logs a first failure at warn, not error, and flags it as the first of its streak', () => {
    const { ulog, streak } = setup()
    expect(streak.fail({ error: 'TypeError: fetch failed' })).toEqual({ first: true, escalated: false })
    expect(ulog.warn).toHaveBeenCalledWith('awc claim failed', { error: 'TypeError: fetch failed' })
    expect(ulog.error).not.toHaveBeenCalled()
  })

  it('stays at warn, and not first, for a streak shorter than 10 minutes', () => {
    const s = setup()
    expect(failFor(s, 9 * MIN + 55_000, 5_000)).toEqual({ first: false, escalated: false })
    expect(s.ulog.error).not.toHaveBeenCalled()
  })

  it('escalates to one error once failures have run for 10 minutes', () => {
    const s = setup()
    expect(failFor(s, 10 * MIN, MIN)).toEqual({ first: false, escalated: true })
    expect(s.ulog.error).toHaveBeenCalledTimes(1)
    expect(s.ulog.error).toHaveBeenCalledWith('awc claim failed', { error: 'x', failures: 11, failingForSec: 600 })
  })

  it('sends no further error or warn rows while the escalated streak continues', () => {
    const s = setup()
    failFor(s, 10 * MIN, MIN)
    s.ulog.warn.mockClear()
    s.advance(MIN)
    expect(s.streak.fail({ error: 'x' }).escalated).toBe(true)
    s.advance(MIN)
    s.streak.fail({ error: 'x' })
    expect(s.ulog.error).toHaveBeenCalledTimes(1)
    expect(s.ulog.warn).not.toHaveBeenCalled()
  })

  // Review: a Mac asleep overnight is not 8 h of failing.
  it('starts a new streak when failures are more than 3 minutes apart (sleep)', () => {
    const { ulog, streak, advance } = setup()
    streak.fail({ error: 'x' })
    advance(8 * 60 * MIN)
    expect(streak.fail({ error: 'x' })).toEqual({ first: true, escalated: false })
    expect(ulog.error).not.toHaveBeenCalled()
  })

  // Review: a fault that fails every other call must still escalate.
  it('keeps the streak through successes in between failures', () => {
    const { ulog, streak, advance } = setup()
    for (let t = 0; t <= 10 * MIN; t += 10_000) {
      streak.fail({ error: 'x' })
      advance(5_000)
      expect(streak.ok()).toBe(false)
      advance(5_000)
    }
    expect(ulog.error).toHaveBeenCalledTimes(1)
    expect(ulog.info).not.toHaveBeenCalled()
  })

  it('logs recovery once, at info, after 3 minutes with no failure', () => {
    const { ulog, streak, advance } = setup()
    streak.fail({ error: 'x' })
    advance(30_000)
    streak.fail({ error: 'x' })
    advance(2 * MIN)
    expect(streak.ok()).toBe(false)
    advance(MIN)
    expect(streak.ok()).toBe(true)
    advance(MIN)
    expect(streak.ok()).toBe(false)
    expect(ulog.info).toHaveBeenCalledTimes(1)
    expect(ulog.info).toHaveBeenCalledWith('awc claim recovered', { failures: 2, failedForSec: 30, escalated: false })
  })

  it('logs nothing on success when there was no streak', () => {
    const { ulog, streak } = setup()
    expect(streak.ok()).toBe(false)
    expect(ulog.info).not.toHaveBeenCalled()
  })

  it('can escalate again in a later streak', () => {
    const s = setup()
    failFor(s, 10 * MIN, MIN)
    s.advance(3 * MIN)
    s.streak.ok()
    expect(s.ulog.info).toHaveBeenCalledWith('awc claim recovered', expect.objectContaining({ escalated: true }))
    failFor(s, 10 * MIN, MIN)
    expect(s.ulog.error).toHaveBeenCalledTimes(2)
  })
})

describe('isTransientNetworkError (#366 review)', () => {
  it.each([
    'TypeError: fetch failed',
    'fetch failed: read ECONNRESET',
    'connect ETIMEDOUT 1.2.3.4:443',
    'getaddrinfo ENOTFOUND x.supabase.co',
    'getaddrinfo EAI_AGAIN x.supabase.co',
    'socket hang up',
  ])('treats %s as a network blip', (msg) => expect(isTransientNetworkError(msg)).toBe(true))

  it.each([
    'Could not find the function public.claim_awc_conversion(p_kinds) in the schema cache (code: PGRST202)',
    'permission denied for function claim_awc_conversion (code: 42501)',
    'Invalid API key',
  ])('treats %s as a real error', (msg) => expect(isTransientNetworkError(msg)).toBe(false))
})
