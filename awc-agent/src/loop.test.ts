// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { createLoop, type LoopDeps } from './loop'

const claim = { id: 4, kind: 'article' as const, contentItemId: 2, sourceUrl: 'https://ex.com/p', attempts: 1, title: 'T', author: 'A', wordCount: 900 }
function deps(over: Partial<LoopDeps> = {}): LoopDeps {
  return {
    claimNext: vi.fn().mockResolvedValue(null),
    runConversion: vi.fn().mockResolvedValue({ outcome: 'generating', path: 'url', episodeTitle: 'T', credits: 5 }),
    recordResult: vi.fn().mockResolvedValue(undefined),
    ulog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    statusLine: vi.fn(),
    nowMs: () => Date.parse('2026-11-06T03:32:00Z'),
    ...over,
  }
}

describe('loop.tick', () => {
  // #368: expected on a new post, so it must not open an alert.
  it('logs too few comments as a warning', async () => {
    const d = deps({
      claimNext: vi.fn().mockResolvedValue({ ...claim, kind: 'comments' }),
      runConversion: vi.fn().mockResolvedValue({ outcome: 'failed', path: null, error: 'too few comments yet' }),
    })
    await createLoop(d).tick()
    expect(d.ulog.warn).toHaveBeenCalledWith('awc comments too few', expect.objectContaining({ conversionId: 4 }))
    expect(d.ulog.error).not.toHaveBeenCalled()
  })
  it('fails a kind this daemon can not run, without starting the agent', async () => {
    const d = deps({ claimNext: vi.fn().mockResolvedValue({ ...claim, kind: 'video' }) })
    await createLoop(d).tick()
    expect(d.runConversion).not.toHaveBeenCalled()
    expect(d.recordResult).toHaveBeenCalledWith(4, { outcome: 'failed', path: null, error: 'unsupported conversion kind' })
  })
  it('idles when nothing is queued', async () => {
    expect(await createLoop(deps()).tick()).toBe('idle')
  })
  it('runs a claimed conversion and records the result', async () => {
    const d = deps({ claimNext: vi.fn().mockResolvedValue(claim) })
    expect(await createLoop(d).tick()).toBe('ran')
    expect(d.recordResult).toHaveBeenCalledWith(4, { outcome: 'generating', path: 'url', episodeTitle: 'T', credits: 5 })
  })
  it('logs a failed conversion to the log service with a fixed message', async () => {
    const d = deps({ claimNext: vi.fn().mockResolvedValue(claim), runConversion: vi.fn().mockResolvedValue({ outcome: 'failed', path: null, error: 'agent timed out' }) })
    await createLoop(d).tick()
    expect(d.ulog.error).toHaveBeenCalledWith('awc conversion failed', expect.objectContaining({ conversionId: 4, error: 'agent timed out' }))
  })
  it('does not log dry runs as errors', async () => {
    const d = deps({ claimNext: vi.fn().mockResolvedValue(claim), runConversion: vi.fn().mockResolvedValue({ outcome: 'failed', path: 'url', error: 'dry run — episode not made' }) })
    await createLoop(d).tick()
    expect(d.ulog.error).not.toHaveBeenCalled()
  })
  // #320: a paywall stop is an expected outcome (the owner isn't a paid subscriber),
  // not a bug — warn, so the alerting job doesn't raise an alert for it.
  it('logs a paywall stop as a warning, not an error', async () => {
    const d = deps({ claimNext: vi.fn().mockResolvedValue(claim), runConversion: vi.fn().mockResolvedValue({ outcome: 'failed', path: 'script', error: 'paywalled — not a paid subscriber to ex.com' }) })
    await createLoop(d).tick()
    expect(d.ulog.error).not.toHaveBeenCalled()
    expect(d.ulog.warn).toHaveBeenCalledWith('awc conversion paywalled', expect.objectContaining({ conversionId: 4, error: 'paywalled — not a paid subscriber to ex.com' }))
  })
  // #339: AWC signed out is shown on the card ("AWC signed out"); an alert
  // per sign-out is noise, so warn instead of error.
  it('logs an AWC sign-out as a warning, not an error', async () => {
    const d = deps({ claimNext: vi.fn().mockResolvedValue(claim), runConversion: vi.fn().mockResolvedValue({ outcome: 'failed', path: null, error: 'not signed in to askwhocasts.com' }) })
    await createLoop(d).tick()
    expect(d.ulog.error).not.toHaveBeenCalled()
    expect(d.ulog.warn).toHaveBeenCalledWith('awc signed out', expect.objectContaining({ conversionId: 4 }))
    expect(d.statusLine).toHaveBeenCalledWith('conversion 4 failed: not signed in to askwhocasts.com')
  })
  // #363: the card shows the pill; warn, so a rare slip doesn't open an issue.
  it('logs a short episode as a warning and records it', async () => {
    const result = { outcome: 'generating', path: 'script', episodeTitle: 'T', credits: 5, reportedWords: 3542, warning: 'short episode: 5 credits for about 3,542 words' }
    const d = deps({ claimNext: vi.fn().mockResolvedValue(claim), runConversion: vi.fn().mockResolvedValue(result) })
    await createLoop(d).tick()
    expect(d.recordResult).toHaveBeenCalledWith(4, result)
    expect(d.ulog.warn).toHaveBeenCalledWith('awc short episode', { conversionId: 4, contentItemId: 2, warning: result.warning, path: 'script' })
    expect(d.ulog.error).not.toHaveBeenCalled()
  })
  it('does not warn on a normal generating run', async () => {
    const d = deps({ claimNext: vi.fn().mockResolvedValue(claim) })
    await createLoop(d).tick()
    expect(d.ulog.warn).not.toHaveBeenCalled()
  })
  // #366: a network blip used to open an alert per burst. A failed
  // claim warns and prints one "retrying" line (not FAILED, which a log watcher
  // reads as unhealthy) until failures have run for 10 minutes.
  const blip = () => new Error('TypeError: fetch failed')
  it('warns on a failed claim and prints a retrying line, not FAILED', async () => {
    const d = deps({ claimNext: vi.fn().mockRejectedValue(blip()) })
    expect(await createLoop(d).tick()).toBe('error')
    expect(d.ulog.warn).toHaveBeenCalledWith('awc claim failed', { error: 'TypeError: fetch failed' })
    expect(d.ulog.error).not.toHaveBeenCalled()
    expect(d.statusLine).toHaveBeenCalledWith('poll retrying: TypeError: fetch failed')
  })
  // Review: a line every 5 s kept the log fresh, so a log watcher's stale_after
  // could never notice the missing heartbeat.
  it('prints only the first retrying line of a streak', async () => {
    let now = Date.parse('2026-11-06T03:32:00Z')
    const d = deps({ claimNext: vi.fn().mockRejectedValue(blip()), nowMs: () => now })
    const loop = createLoop(d)
    for (let i = 0; i < 5; i++) { await loop.tick(); now += 5_000 }
    expect(d.statusLine).toHaveBeenCalledTimes(1)
  })
  it('escalates claim failures to one error and FAILED lines after 10 minutes', async () => {
    let now = Date.parse('2026-11-06T03:32:00Z')
    const d = deps({ claimNext: vi.fn().mockRejectedValue(blip()), nowMs: () => now })
    const loop = createLoop(d)
    for (let t = 0; t <= 10 * 60_000; t += 60_000) { await loop.tick(); now += 60_000 }
    now -= 55_000
    await loop.tick()
    expect(d.ulog.error).toHaveBeenCalledTimes(1)
    expect(d.ulog.error).toHaveBeenCalledWith('awc claim failed', { error: 'TypeError: fetch failed', failures: 11, failingForSec: 600 })
    expect(d.statusLine).toHaveBeenLastCalledWith('poll FAILED: TypeError: fetch failed')
  })
  // Review: a missing RPC or a permission error won't clear by itself.
  it('logs a non-network claim error as an error at once, with a FAILED line', async () => {
    const d = deps({ claimNext: vi.fn().mockRejectedValue({ message: 'Could not find the function public.claim_awc_conversion', code: 'PGRST202' }) })
    expect(await createLoop(d).tick()).toBe('error')
    expect(d.ulog.error).toHaveBeenCalledWith('awc claim failed', { error: 'Could not find the function public.claim_awc_conversion (code: PGRST202)' })
    expect(d.ulog.warn).not.toHaveBeenCalled()
    expect(d.statusLine).toHaveBeenCalledWith('poll FAILED: Could not find the function public.claim_awc_conversion (code: PGRST202)')
  })
  it('logs recovery once, with a status line, after 3 minutes without a failed claim', async () => {
    let now = Date.parse('2026-11-06T03:32:00Z')
    const claimNext = vi.fn().mockRejectedValueOnce(blip()).mockResolvedValue(null)
    const d = deps({ claimNext, nowMs: () => now })
    const loop = createLoop(d)
    await loop.tick()
    now += 5_000
    expect(await loop.tick()).toBe('idle')
    expect(d.ulog.info).not.toHaveBeenCalled()
    now += 3 * 60_000
    await loop.tick()
    now += 5_000
    await loop.tick()
    expect(d.ulog.info).toHaveBeenCalledTimes(1)
    expect(d.ulog.info).toHaveBeenCalledWith('awc claim recovered', expect.objectContaining({ failures: 1 }))
    expect(d.statusLine).toHaveBeenLastCalledWith('poll recovered')
  })
  it('logs the message of a plain supabase error object, not [object Object] (#335)', async () => {
    const d = deps({ claimNext: vi.fn().mockRejectedValue({ message: 'TypeError: fetch failed', code: '' }) })
    await createLoop(d).tick()
    expect(d.ulog.warn).toHaveBeenCalledWith('awc claim failed', { error: 'TypeError: fetch failed' })
    expect(vi.mocked(d.statusLine).mock.calls.some((c) => String(c[0]).includes('[object Object]'))).toBe(false)
  })
  // A crash inside a conversion is a bug, not a network blip: still an error at once.
  it('logs an error at once when running a claimed conversion throws', async () => {
    const d = deps({ claimNext: vi.fn().mockResolvedValue(claim), runConversion: vi.fn().mockRejectedValue(new Error('boom')) })
    expect(await createLoop(d).tick()).toBe('error')
    expect(d.ulog.error).toHaveBeenCalledWith('awc conversion crashed', { conversionId: 4, error: 'boom' })
    expect(d.statusLine).toHaveBeenCalledWith('conversion 4 FAILED: boom')
  })
  it('records a failure when recordResult itself throws, without crashing', async () => {
    const d = deps({ claimNext: vi.fn().mockResolvedValue(claim), recordResult: vi.fn().mockRejectedValue(new Error('x')) })
    expect(await createLoop(d).tick()).toBe('error')
    expect(d.ulog.error).toHaveBeenCalledWith('awc result write failed', expect.anything())
  })
})
