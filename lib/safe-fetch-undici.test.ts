/**
 * #281 F15 follow-up: the guarded Agent must be used with undici's OWN fetch.
 * Handing an undici 7 Agent to Node's built-in fetch (a different bundled
 * undici on Node 26) silently dropped response headers — Location vanished
 * from 301s and gzip bodies were not decoded, so every RSS feed failed.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('node:dns/promises', () => {
  const lookup = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
  return { default: { lookup }, lookup }
})

const undiciFetch = vi.fn()
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>()
  return { ...actual, fetch: (...a: unknown[]) => undiciFetch(...a) }
})

import { safeFetch } from './safe-fetch'

describe('safeFetch transport', () => {
  it("uses undici's fetch with the guarded dispatcher, not the global fetch", async () => {
    const globalSpy = vi.spyOn(globalThis, 'fetch')
    undiciFetch.mockResolvedValue(new Response('ok', { status: 200 }))

    const res = await safeFetch('https://example.com/feed')

    expect(res.status).toBe(200)
    expect(undiciFetch).toHaveBeenCalledTimes(1)
    expect(undiciFetch.mock.calls[0][1]).toEqual(expect.objectContaining({ redirect: 'manual', dispatcher: expect.anything() }))
    expect(globalSpy).not.toHaveBeenCalled()
  })
})
