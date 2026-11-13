/**
 * #281 F15: assertPublicUrl resolves DNS, then fetch resolved again — a
 * rebinding DNS server could answer the check with a public IP and the real
 * connection with 127.0.0.1. safeFetch now connects through a dispatcher whose
 * lookup re-checks every address the socket will actually use.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import dns from 'node:dns'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

vi.mock('node:dns/promises', () => {
  const lookup = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
  return { default: { lookup }, lookup }
})

import { guardedLookup, safeFetch, UnsafeUrlError } from './safe-fetch'

function lookupWith(addresses: { address: string; family: number }[]) {
  return vi.spyOn(dns, 'lookup').mockImplementation(((
    _host: string,
    _opts: unknown,
    cb: (err: Error | null, a: unknown) => void
  ) => cb(null, addresses)) as unknown as typeof dns.lookup)
}

function callGuarded(options: dns.LookupOptions): Promise<{ err: Error | null; result: unknown[] }> {
  return new Promise((resolve) => {
    guardedLookup('rebind.example', options, (err: Error | null, ...result: unknown[]) =>
      resolve({ err, result })
    )
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('guardedLookup', () => {
  it('rejects when the connect-time answer is a blocked address', async () => {
    lookupWith([{ address: '127.0.0.1', family: 4 }])
    const { err } = await callGuarded({})
    expect(err).toBeInstanceOf(UnsafeUrlError)
  })

  it('rejects if ANY address in an all:true answer is blocked', async () => {
    lookupWith([
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ])
    const { err } = await callGuarded({ all: true })
    expect(err).toBeInstanceOf(UnsafeUrlError)
  })

  it('passes public answers through in both callback shapes', async () => {
    lookupWith([{ address: '93.184.216.34', family: 4 }])
    expect(await callGuarded({})).toEqual({ err: null, result: ['93.184.216.34', 4] })
    expect(await callGuarded({ all: true })).toEqual({
      err: null,
      result: [[{ address: '93.184.216.34', family: 4 }]],
    })
  })
})

describe('safeFetch connection pinning (real socket)', () => {
  it('refuses to connect when DNS rebinds to loopback after the pre-check', async () => {
    // A real local server: if the connect-time lookup were not guarded, the
    // request would reach it.
    let hits = 0
    const server = createServer((_req, res) => {
      hits++
      res.end('internal')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const { port } = server.address() as AddressInfo
    try {
      // Pre-check (dns/promises, mocked above) says public; connect-time says loopback.
      lookupWith([{ address: '127.0.0.1', family: 4 }])
      await expect(safeFetch(`http://rebind.example:${port}/`)).rejects.toThrow()
      expect(hits).toBe(0)
    } finally {
      server.close()
    }
  })
})
