import { beforeEach, describe, expect, it, vi } from 'vitest'
import RssParser from 'rss-parser'
import { UnsafeUrlError } from '@/lib/safe-fetch'
import { fetchFeed, MAX_FEED_BYTES } from './fetch-feed'

vi.mock('@/lib/safe-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/safe-fetch')>()
  return { ...actual, safeFetch: vi.fn() }
})

import { safeFetch } from '@/lib/safe-fetch'
const mockSafeFetch = vi.mocked(safeFetch)

const RSS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Chan Title</title>
  <item><title>Post 1</title><link>https://example.com/1</link></item>
</channel></rss>`

beforeEach(() => {
  mockSafeFetch.mockReset()
})

describe('fetchFeed', () => {
  it('fetches through safeFetch with rss-parser-compatible headers and parses the XML', async () => {
    mockSafeFetch.mockResolvedValue(new Response(RSS_XML, { status: 200 }))

    const feed = await fetchFeed('https://example.com/feed', new RssParser())

    expect(feed.title).toBe('Chan Title')
    expect(feed.items).toHaveLength(1)
    expect(feed.items[0].title).toBe('Post 1')

    expect(mockSafeFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockSafeFetch.mock.calls[0]
    expect(url).toBe('https://example.com/feed')
    // parseURL sent these (rss-parser/lib/parser.js) — a bare undici UA can
    // trip feed-host WAFs, so preserve them (plan review B1).
    expect(opts?.headers).toMatchObject({
      'User-Agent': 'rss-parser',
      Accept: 'application/rss+xml',
    })
    expect(opts?.timeoutMs).toBe(10_000)
  })

  it('throws with the status on a non-2xx response', async () => {
    mockSafeFetch.mockResolvedValue(new Response('gone', { status: 404 }))
    await expect(fetchFeed('https://example.com/feed', new RssParser())).rejects.toThrow(/404/)
  })

  it('propagates UnsafeUrlError from the guard', async () => {
    mockSafeFetch.mockRejectedValue(new UnsafeUrlError('Blocked address: 127.0.0.1'))
    await expect(fetchFeed('http://127.0.0.1/feed', new RssParser())).rejects.toThrow(UnsafeUrlError)
  })

  it('rejects on unparseable (e.g. cap-truncated) XML', async () => {
    mockSafeFetch.mockResolvedValue(new Response(RSS_XML.slice(0, 60), { status: 200 }))
    await expect(fetchFeed('https://example.com/feed', new RssParser())).rejects.toThrow()
  })

  it('throws a clear size-limit error (not truncated XML) when the body exceeds the cap', async () => {
    // Single chunk just over the cap: readTextCapped detects the overflow and
    // throws before handing partial XML to the parser (#234).
    const oversized = new Uint8Array(MAX_FEED_BYTES + 1)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized)
        controller.close()
      },
    })
    mockSafeFetch.mockResolvedValue(new Response(stream, { status: 200 }))

    await expect(fetchFeed('https://example.com/feed', new RssParser())).rejects.toThrow(
      /size limit/i
    )
  })
})

// #281 F12: rss-parser's parseURL does its own fetch — unguarded redirects to
// private addresses, unbounded body. Every feed fetch, scripts included, must
// go through fetchFeed (safeFetch + body cap).
describe('no unguarded parseURL callers', () => {
  it('nothing in app/, lib/ or scripts/ calls rss-parser parseURL', async () => {
    const { execFileSync } = await import('node:child_process')
    let hits = ''
    try {
      hits = execFileSync('git', ['grep', '-n', '\\.parseURL(', '--', 'app', 'lib', 'scripts'], {
        encoding: 'utf8',
      })
    } catch {
      // git grep exits 1 on no matches
    }
    const offenders = hits
      .split('\n')
      .filter(Boolean)
      .filter((l) => !l.includes('.test.ts'))
    expect(offenders).toEqual([])
  })
})
