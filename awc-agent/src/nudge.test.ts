// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { createNudger } from './nudge'
describe('createNudger', () => {
  it('calls the sync route with the bearer secret at most every 2 minutes while generating', async () => {
    let now = 0
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))
    const n = createNudger({ fetch: fetchMock, deployUrl: 'https://app', secret: 's3', nowMs: () => now })
    expect(await n.maybeNudge(0)).toBe(false)
    expect(await n.maybeNudge(1)).toBe(true)
    now = 60_000
    expect(await n.maybeNudge(1)).toBe(false)
    now = 121_000
    expect(await n.maybeNudge(2)).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('https://app/api/cron/askwhocasts-sync', expect.objectContaining({ headers: { Authorization: 'Bearer s3' } }))
    // bounded: a hung Vercel call must not stall the daemon
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })
  it('swallows network errors but reports them', async () => {
    const onFailure = vi.fn()
    const n = createNudger({ fetch: vi.fn().mockRejectedValue(new Error('offline')), deployUrl: 'https://app', secret: 's', nowMs: () => 0, onFailure })
    expect(await n.maybeNudge(1)).toBe(false)
    expect(onFailure).toHaveBeenCalledWith(expect.stringContaining('offline'))
  })

  it('reports a non-2xx response (e.g. a rotated SYNC_API_SECRET → 401)', async () => {
    const onFailure = vi.fn()
    const n = createNudger({ fetch: vi.fn().mockResolvedValue(new Response('no', { status: 401 })), deployUrl: 'https://app', secret: 's', nowMs: () => 0, onFailure })
    expect(await n.maybeNudge(1)).toBe(false)
    expect(onFailure).toHaveBeenCalledWith('HTTP 401')
  })
})
