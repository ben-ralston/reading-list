import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertPublicUrl,
  isBlockedIp,
  readTextCapped,
  ResponseTooLargeError,
  safeFetch,
  UnsafeUrlError,
} from './safe-fetch'
import { lookup } from 'node:dns/promises'

vi.mock('node:dns/promises', () => {
  const lookup = vi.fn()
  return { default: { lookup }, lookup }
})

const mockLookup = vi.mocked(lookup) as ReturnType<typeof vi.fn>

// safeFetch transports via undici's fetch (#281 F15); route it through the
// global fetch these tests replace, so they keep asserting on the same calls.
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>()
  return { ...actual, fetch: (...a: Parameters<typeof fetch>) => globalThis.fetch(...a) }
})

function publicDns(address = '93.184.216.34') {
  mockLookup.mockResolvedValue([{ address, family: 4 }])
}

describe('isBlockedIp', () => {
  describe('IPv4 blocked ranges', () => {
    it.each([
      ['0.0.0.0', '0.0.0.0/8 "this network"'],
      ['0.255.255.255', '0.0.0.0/8 upper bound'],
      ['10.0.0.1', 'RFC1918 10/8'],
      ['10.255.255.255', 'RFC1918 10/8 upper bound'],
      ['100.64.0.1', 'CGNAT 100.64/10'],
      ['100.127.255.255', 'CGNAT 100.64/10 upper bound'],
      ['127.0.0.1', 'loopback'],
      ['127.255.255.255', 'loopback upper bound'],
      ['169.254.169.254', 'link-local / cloud metadata'],
      ['169.254.0.1', 'link-local lower'],
      ['172.16.0.1', 'RFC1918 172.16/12'],
      ['172.31.255.255', 'RFC1918 172.16/12 upper bound'],
      ['192.0.0.1', 'IETF protocol assignments 192.0.0/24'],
      ['192.0.2.1', 'TEST-NET-1'],
      ['198.51.100.7', 'TEST-NET-2'],
      ['203.0.113.9', 'TEST-NET-3'],
      ['192.168.1.1', 'RFC1918 192.168/16'],
      ['198.18.0.1', 'benchmarking 198.18/15'],
      ['198.19.255.255', 'benchmarking upper bound'],
      ['224.0.0.1', 'multicast 224/4'],
      ['239.255.255.255', 'multicast upper bound'],
      ['240.0.0.1', 'reserved 240/4'],
      ['255.255.255.255', 'broadcast'],
    ])('blocks %s (%s)', (ip) => {
      expect(isBlockedIp(ip)).toBe(true)
    })
  })

  describe('IPv4 public addresses', () => {
    it.each([
      ['1.1.1.1'],
      ['8.8.8.8'],
      ['104.16.0.1'],
      ['100.63.255.255'], // just below CGNAT
      ['100.128.0.0'], // just above CGNAT
      ['172.15.255.255'], // just below 172.16/12
      ['172.32.0.0'], // just above 172.16/12
      ['9.255.255.255'], // just below 10/8
      ['11.0.0.0'], // just above 10/8
      ['223.255.255.255'], // just below multicast
    ])('allows %s', (ip) => {
      expect(isBlockedIp(ip)).toBe(false)
    })
  })

  describe('IPv6 blocked ranges', () => {
    it.each([
      ['::', 'unspecified'],
      ['::1', 'loopback'],
      ['fc00::1', 'unique-local fc00::/7'],
      ['fd12:3456:789a::1', 'unique-local fd00::/8'],
      ['fe80::1', 'link-local fe80::/10'],
      ['febf::1', 'link-local upper bound'],
      ['ff02::1', 'multicast ff00::/8'],
      ['64:ff9b::a9fe:a9fe', 'NAT64 embedding metadata IP'],
      ['64:ff9b::808:808', 'NAT64 64:ff9b::/96'],
    ])('blocks %s (%s)', (ip) => {
      expect(isBlockedIp(ip)).toBe(true)
    })
  })

  describe('IPv4-mapped IPv6 (structural detection, not dotted-quad regex)', () => {
    // WHATWG URL canonicalizes http://[::ffff:169.254.169.254]/ to hostname
    // [::ffff:a9fe:a9fe] — the HEX-COMPRESSED form. A dotted-quad unwrap regex
    // would let cloud-metadata SSRF straight through (plan review A1).
    it.each([
      ['::ffff:7f00:1', 'hex-compressed mapped 127.0.0.1'],
      ['::ffff:a9fe:a9fe', 'hex-compressed mapped 169.254.169.254'],
      ['::ffff:127.0.0.1', 'dotted mapped loopback'],
      ['::ffff:169.254.169.254', 'dotted mapped metadata'],
      ['::ffff:10.0.0.1', 'dotted mapped RFC1918'],
      ['::ffff:c0a8:101', 'hex-compressed mapped 192.168.1.1'],
    ])('blocks %s (%s)', (ip) => {
      expect(isBlockedIp(ip)).toBe(true)
    })

    it.each([
      ['::ffff:1.1.1.1', 'dotted mapped public'],
      ['::ffff:101:101', 'hex-compressed mapped public 1.1.1.1'],
    ])('allows %s (%s)', (ip) => {
      expect(isBlockedIp(ip)).toBe(false)
    })
  })

  describe('IPv6 public addresses', () => {
    it.each([
      ['2606:4700:4700::1111'], // Cloudflare DNS
      ['2001:4860:4860::8888'], // Google DNS
    ])('allows %s', (ip) => {
      expect(isBlockedIp(ip)).toBe(false)
    })
  })

  it('blocks unparseable input (fail closed)', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true)
    expect(isBlockedIp('')).toBe(true)
    expect(isBlockedIp('999.999.999.999')).toBe(true)
  })
})

describe('assertPublicUrl', () => {
  beforeEach(() => {
    mockLookup.mockReset()
  })

  it('rejects non-http(s) protocols', async () => {
    await expect(assertPublicUrl(new URL('ftp://example.com/'))).rejects.toThrow(UnsafeUrlError)
    await expect(assertPublicUrl(new URL('file:///etc/passwd'))).rejects.toThrow(UnsafeUrlError)
  })

  it('rejects IPv4 literal hosts in blocked ranges without a DNS lookup', async () => {
    await expect(assertPublicUrl(new URL('http://127.0.0.1/'))).rejects.toThrow(UnsafeUrlError)
    await expect(assertPublicUrl(new URL('http://169.254.169.254/latest/meta-data/'))).rejects.toThrow(
      UnsafeUrlError
    )
    expect(mockLookup).not.toHaveBeenCalled()
  })

  it('rejects exotic IPv4 literal forms (URL canonicalizes hex/decimal/octal)', async () => {
    // new URL() canonicalizes these to 127.0.0.1 before we ever see them
    await expect(assertPublicUrl(new URL('http://0x7f000001/'))).rejects.toThrow(UnsafeUrlError)
    await expect(assertPublicUrl(new URL('http://2130706433/'))).rejects.toThrow(UnsafeUrlError)
    await expect(assertPublicUrl(new URL('http://127.1/'))).rejects.toThrow(UnsafeUrlError)
  })

  it('rejects bracketed IPv6 literal hosts, including hex-compressed mapped IPv4', async () => {
    await expect(assertPublicUrl(new URL('http://[::1]/'))).rejects.toThrow(UnsafeUrlError)
    await expect(assertPublicUrl(new URL('http://[::ffff:169.254.169.254]/'))).rejects.toThrow(
      UnsafeUrlError
    )
    expect(mockLookup).not.toHaveBeenCalled()
  })

  it('rejects hostnames whose DNS resolves to a private address', async () => {
    mockLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }])
    await expect(assertPublicUrl(new URL('http://internal.example.com/'))).rejects.toThrow(
      UnsafeUrlError
    )
  })

  it('rejects when ANY resolved address is private (multi-A rebinding trick)', async () => {
    mockLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ])
    await expect(assertPublicUrl(new URL('http://sneaky.example.com/'))).rejects.toThrow(UnsafeUrlError)
  })

  it('rejects hostnames resolving to a private IPv6 address', async () => {
    mockLookup.mockResolvedValue([{ address: 'fd00::1', family: 6 }])
    await expect(assertPublicUrl(new URL('http://v6-internal.example.com/'))).rejects.toThrow(
      UnsafeUrlError
    )
  })

  it('allows hostnames resolving only to public addresses', async () => {
    publicDns()
    await expect(assertPublicUrl(new URL('https://example.com/feed.xml'))).resolves.toBeUndefined()
  })

  it('allows public IP literals', async () => {
    await expect(assertPublicUrl(new URL('http://93.184.216.34/'))).resolves.toBeUndefined()
    expect(mockLookup).not.toHaveBeenCalled()
  })

  it('propagates DNS failures as non-UnsafeUrlError (NXDOMAIN is a fetch failure, not a block)', async () => {
    mockLookup.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }))
    const err = await assertPublicUrl(new URL('http://nope.example.com/')).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(UnsafeUrlError)
  })
})

describe('safeFetch', () => {
  const realFetch = global.fetch

  beforeEach(() => {
    mockLookup.mockReset()
    publicDns()
  })

  afterEach(() => {
    global.fetch = realFetch
  })

  function fetchReturning(...responses: Response[]) {
    const mock = vi.fn()
    for (const r of responses) mock.mockResolvedValueOnce(r)
    global.fetch = mock as unknown as typeof fetch
    return mock
  }

  function redirect(status: number, location: string): Response {
    return new Response(null, { status, headers: { location } })
  }

  it('returns a non-redirect response and passes headers through', async () => {
    const mock = fetchReturning(new Response('hello', { status: 200 }))
    const res = await safeFetch('https://example.com/page', {
      headers: { 'User-Agent': 'ReadingListBot/1.0' },
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello')
    expect(mock).toHaveBeenCalledTimes(1)
    const [calledUrl, init] = mock.mock.calls[0]
    expect(calledUrl).toBe('https://example.com/page')
    expect(init.redirect).toBe('manual')
    expect(init.headers).toEqual({ 'User-Agent': 'ReadingListBot/1.0' })
  })

  it('validates the URL before fetching (blocked target never reaches fetch)', async () => {
    const mock = fetchReturning()
    await expect(safeFetch('http://127.0.0.1/admin')).rejects.toThrow(UnsafeUrlError)
    expect(mock).not.toHaveBeenCalled()
  })

  it('follows redirects to public targets, resolving relative Locations', async () => {
    const mock = fetchReturning(
      redirect(301, '/moved/here'),
      new Response('final', { status: 200 })
    )
    const res = await safeFetch('https://example.com/start')
    expect(await res.text()).toBe('final')
    expect(mock).toHaveBeenCalledTimes(2)
    expect(mock.mock.calls[1][0]).toBe('https://example.com/moved/here')
  })

  it('re-validates every redirect hop: redirect to a private target is blocked', async () => {
    const mock = fetchReturning(redirect(302, 'http://169.254.169.254/latest/meta-data/'))
    await expect(safeFetch('https://example.com/start')).rejects.toThrow(UnsafeUrlError)
    expect(mock).toHaveBeenCalledTimes(1) // the private hop was never fetched
  })

  it('re-validates redirect hostnames via DNS (redirect to name resolving private)', async () => {
    mockLookup.mockImplementation(async (host: string) => {
      if (host === 'internal.example.com') return [{ address: '192.168.1.10', family: 4 }]
      return [{ address: '93.184.216.34', family: 4 }]
    })
    const mock = fetchReturning(redirect(302, 'https://internal.example.com/'))
    await expect(safeFetch('https://example.com/start')).rejects.toThrow(UnsafeUrlError)
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('throws after exceeding maxRedirects', async () => {
    fetchReturning(
      redirect(302, 'https://example.com/1'),
      redirect(302, 'https://example.com/2'),
      redirect(302, 'https://example.com/3'),
      redirect(302, 'https://example.com/4')
    )
    await expect(safeFetch('https://example.com/start', { maxRedirects: 3 })).rejects.toThrow(
      /redirect/i
    )
  })

  it('aborts on timeout', async () => {
    global.fetch = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject((init.signal as AbortSignal).reason))
        })
    ) as unknown as typeof fetch
    await expect(safeFetch('https://example.com/slow', { timeoutMs: 20 })).rejects.toThrow()
  })
})

describe('readTextCapped', () => {
  function streamedResponse(chunks: string[]): Response {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
    return new Response(stream, { status: 200 })
  }

  it('returns the full body when under the cap', async () => {
    const res = streamedResponse(['hello ', 'world'])
    expect(await readTextCapped(res, 1024)).toBe('hello world')
  })

  it('truncates at the cap and stops reading', async () => {
    const res = streamedResponse(['aaaa', 'bbbb', 'cccc'])
    expect(await readTextCapped(res, 6)).toBe('aaaabb')
  })

  it('handles a single chunk larger than the cap', async () => {
    const res = streamedResponse(['x'.repeat(100)])
    expect(await readTextCapped(res, 10)).toBe('x'.repeat(10))
  })

  it('returns empty string for an empty body', async () => {
    expect(await readTextCapped(new Response(null, { status: 204 }), 10)).toBe('')
  })

  describe('throwOnCap', () => {
    it('throws ResponseTooLargeError instead of silently truncating', async () => {
      const res = streamedResponse(['aaaa', 'bbbb', 'cccc'])
      await expect(readTextCapped(res, 6, { throwOnCap: true })).rejects.toBeInstanceOf(
        ResponseTooLargeError
      )
    })

    it('throws when a single chunk exceeds the cap', async () => {
      const res = streamedResponse(['x'.repeat(100)])
      await expect(readTextCapped(res, 10, { throwOnCap: true })).rejects.toBeInstanceOf(
        ResponseTooLargeError
      )
    })

    it('returns the full body when it fits within the cap', async () => {
      const res = streamedResponse(['hello ', 'world'])
      expect(await readTextCapped(res, 1024, { throwOnCap: true })).toBe('hello world')
    })

    it('does not throw for a body exactly at the cap', async () => {
      const res = streamedResponse(['x'.repeat(10)])
      expect(await readTextCapped(res, 10, { throwOnCap: true })).toBe('x'.repeat(10))
    })
  })
})
