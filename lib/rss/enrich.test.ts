import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  deriveYouTubeThumbnail,
  imageFromRssItem,
  parseItunesDuration,
  wordCountFromHtml,
  ogImageFromHtml,
  fetchOgImage,
  enrichFromRssItem,
  enrichFromUrl,
} from './enrich'
import type { RssItem } from './parser'

vi.mock('@/lib/safe-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/safe-fetch')>()
  return { ...actual, safeFetch: vi.fn() }
})
import { safeFetch, UnsafeUrlError } from '@/lib/safe-fetch'
const mockSafeFetch = vi.mocked(safeFetch)

function time(fn: () => unknown): number {
  const start = performance.now()
  fn()
  return performance.now() - start
}

// ---------------------------------------------------------------------------
// deriveYouTubeThumbnail
// ---------------------------------------------------------------------------

describe('deriveYouTubeThumbnail', () => {
  it('derives from a watch?v= URL', () => {
    expect(deriveYouTubeThumbnail('https://www.youtube.com/watch?v=dQw4w9WgXcQ'))
      .toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg')
  })

  it('derives from a youtu.be short URL', () => {
    expect(deriveYouTubeThumbnail('https://youtu.be/dQw4w9WgXcQ'))
      .toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg')
  })

  it('derives from a /shorts/ URL', () => {
    expect(deriveYouTubeThumbnail('https://www.youtube.com/shorts/dQw4w9WgXcQ'))
      .toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg')
  })

  it('returns null for a non-YouTube URL', () => {
    expect(deriveYouTubeThumbnail('https://example.com/post')).toBeNull()
  })

  it('returns null for empty/garbage input', () => {
    expect(deriveYouTubeThumbnail('')).toBeNull()
    expect(deriveYouTubeThumbnail('not a url')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// parseItunesDuration
// ---------------------------------------------------------------------------

describe('parseItunesDuration', () => {
  it('parses HH:MM:SS', () => {
    expect(parseItunesDuration('01:02:03')).toBe(3723)
  })

  it('parses MM:SS', () => {
    expect(parseItunesDuration('45:30')).toBe(2730)
  })

  it('parses plain seconds string', () => {
    expect(parseItunesDuration('600')).toBe(600)
  })

  it('parses a numeric value', () => {
    expect(parseItunesDuration(600)).toBe(600)
  })

  it('returns null for empty/undefined/garbage', () => {
    expect(parseItunesDuration('')).toBeNull()
    expect(parseItunesDuration(undefined)).toBeNull()
    expect(parseItunesDuration(null)).toBeNull()
    expect(parseItunesDuration('abc')).toBeNull()
  })

  it('returns null for zero / negative durations', () => {
    expect(parseItunesDuration('0')).toBeNull()
    expect(parseItunesDuration(0)).toBeNull()
    expect(parseItunesDuration('00:00')).toBeNull()
    expect(parseItunesDuration('-1:30')).toBeNull()
    expect(parseItunesDuration(-5)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// wordCountFromHtml
// ---------------------------------------------------------------------------

describe('wordCountFromHtml', () => {
  it('counts words after stripping tags', () => {
    expect(wordCountFromHtml('<p>one two three</p>')).toBe(3)
  })

  it('strips script and style blocks before counting', () => {
    expect(wordCountFromHtml('<script>var x = 1 + 2 + 3</script><p>hello world</p>')).toBe(2)
  })

  it('decodes common entities and ignores extra whitespace', () => {
    expect(wordCountFromHtml('<p>a&amp;b   c\n\nd</p>')).toBe(3)
  })

  it('runs in linear time on feed-controlled HTML (#281 F2/F8 ReDoS)', () => {
    expect(time(() => wordCountFromHtml('<'.repeat(60_000)))).toBeLessThan(100)
    expect(time(() => wordCountFromHtml('<script>'.repeat(20_000)))).toBeLessThan(100)
  })

  it('counts the whole body, even past 512 KB', () => {
    const body = '<p>word</p>'.repeat(60_000) // ~660 KB
    expect(wordCountFromHtml(body)).toBe(60_000)
  })

  it('returns null for empty/whitespace/nullish', () => {
    expect(wordCountFromHtml('')).toBeNull()
    expect(wordCountFromHtml('   ')).toBeNull()
    expect(wordCountFromHtml(undefined)).toBeNull()
    expect(wordCountFromHtml(null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ogImageFromHtml
// ---------------------------------------------------------------------------

describe('ogImageFromHtml', () => {
  it('extracts og:image (property attr)', () => {
    const html = '<head><meta property="og:image" content="https://cdn.example.com/a.jpg"></head>'
    expect(ogImageFromHtml(html)).toBe('https://cdn.example.com/a.jpg')
  })

  it('extracts og:image when content precedes property', () => {
    const html = '<meta content="https://cdn.example.com/b.jpg" property="og:image" />'
    expect(ogImageFromHtml(html)).toBe('https://cdn.example.com/b.jpg')
  })

  it('falls back to twitter:image', () => {
    const html = '<meta name="twitter:image" content="https://cdn.example.com/t.jpg">'
    expect(ogImageFromHtml(html)).toBe('https://cdn.example.com/t.jpg')
  })

  it('runs in linear time on unclosed meta tags (#281 F16 ReDoS)', () => {
    expect(time(() => ogImageFromHtml('<meta '.repeat(20_000)))).toBeLessThan(100)
  })

  it('returns null when no image meta present', () => {
    expect(ogImageFromHtml('<head><title>No image</title></head>')).toBeNull()
  })

  it('rejects a relative og:image (must be an absolute http(s) URL)', () => {
    expect(ogImageFromHtml('<meta property="og:image" content="/images/foo.png">')).toBeNull()
    expect(ogImageFromHtml('<meta property="og:image" content="//cdn.example.com/x.jpg">')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// imageFromRssItem
// ---------------------------------------------------------------------------

describe('imageFromRssItem', () => {
  it('uses an image enclosure', () => {
    const item: RssItem = { enclosure: { url: 'https://cdn.example.com/e.jpg', type: 'image/jpeg' } }
    expect(imageFromRssItem(item)).toBe('https://cdn.example.com/e.jpg')
  })

  it('ignores a non-image enclosure (e.g. audio) and falls through', () => {
    const item: RssItem = { enclosure: { url: 'https://cdn.example.com/ep.mp3', type: 'audio/mpeg' } }
    expect(imageFromRssItem(item)).toBeNull()
  })

  it('uses itunes.image', () => {
    const item: RssItem = { itunes: { image: 'https://cdn.example.com/show.jpg' } }
    expect(imageFromRssItem(item)).toBe('https://cdn.example.com/show.jpg')
  })

  it('uses media:thumbnail url attribute', () => {
    const item: RssItem = { 'media:thumbnail': { $: { url: 'https://cdn.example.com/m.jpg' } } }
    expect(imageFromRssItem(item)).toBe('https://cdn.example.com/m.jpg')
  })

  it('returns null when no image fields present', () => {
    expect(imageFromRssItem({ title: 'x' })).toBeNull()
  })

  it('rejects a relative enclosure url (must be absolute http(s))', () => {
    const item: RssItem = { enclosure: { url: '/images/e.jpg', type: 'image/jpeg' } }
    expect(imageFromRssItem(item)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// enrichFromRssItem (sync, cheap signals)
// ---------------------------------------------------------------------------

describe('enrichFromRssItem', () => {
  it('derives a YouTube thumbnail from the link', () => {
    const item: RssItem = { link: 'https://youtu.be/dQw4w9WgXcQ', content: '<p>hi there world</p>' }
    const result = enrichFromRssItem(item)
    expect(result.imageUrl).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg')
    expect(result.wordCount).toBe(3)
    expect(result.durationSeconds).toBeNull()
  })

  it('reads enclosure image + content:encoded word count', () => {
    const item: RssItem = {
      link: 'https://blog.example.com/post',
      enclosure: { url: 'https://cdn.example.com/cover.jpg', type: 'image/png' },
      'content:encoded': '<p>one two three four five</p>',
    }
    const result = enrichFromRssItem(item)
    expect(result.imageUrl).toBe('https://cdn.example.com/cover.jpg')
    expect(result.wordCount).toBe(5)
  })

  it('parses itunes duration for podcasts', () => {
    const item: RssItem = { link: 'https://pod.example.com/ep', itunes: { duration: '45:30' } }
    expect(enrichFromRssItem(item).durationSeconds).toBe(2730)
  })

  it('returns all-null when nothing is available', () => {
    expect(enrichFromRssItem({ title: 'bare' })).toEqual({
      imageUrl: null,
      wordCount: null,
      durationSeconds: null,
    })
  })
})

// ---------------------------------------------------------------------------
// fetchOgImage / enrichFromUrl (network, mocked at safeFetch)
// ---------------------------------------------------------------------------

describe('fetchOgImage', () => {
  beforeEach(() => {
    mockSafeFetch.mockReset()
  })

  it('fetches through the SSRF guard without following redirects (#281 F5)', async () => {
    mockSafeFetch.mockResolvedValue(
      new Response('<meta property="og:image" content="https://cdn.example.com/x.jpg">')
    )
    expect(await fetchOgImage('https://blog.example.com/post')).toBe('https://cdn.example.com/x.jpg')
    // maxRedirects:0 so a feed link can't 30x-redirect the server anywhere;
    // safeFetch itself blocks private/loopback/metadata addresses.
    expect(mockSafeFetch).toHaveBeenCalledWith(
      'https://blog.example.com/post',
      expect.objectContaining({ maxRedirects: 0 }),
    )
  })

  it('returns null when the SSRF guard rejects the URL', async () => {
    mockSafeFetch.mockRejectedValue(new UnsafeUrlError('Blocked address: 169.254.169.254'))
    expect(await fetchOgImage('http://169.254.169.254/latest/meta-data/')).toBeNull()
  })

  it('returns null for a non-http(s) URL without fetching', async () => {
    expect(await fetchOgImage('file:///etc/passwd')).toBeNull()
    expect(mockSafeFetch).not.toHaveBeenCalled()
  })

  it('returns null (never throws) when the fetch rejects', async () => {
    mockSafeFetch.mockRejectedValue(new Error('network down'))
    await expect(fetchOgImage('https://blog.example.com/post')).resolves.toBeNull()
  })

  it('returns null when the response is not ok', async () => {
    mockSafeFetch.mockResolvedValue(new Response('', { status: 500 }))
    expect(await fetchOgImage('https://blog.example.com/post')).toBeNull()
  })
})

describe('enrichFromUrl', () => {
  beforeEach(() => {
    mockSafeFetch.mockReset()
  })

  it('returns og:image and a rough word count from one fetch', async () => {
    mockSafeFetch.mockResolvedValue(
      new Response(
        '<html><head><meta property="og:image" content="https://cdn.example.com/og.jpg"></head>' +
          '<body><p>alpha beta gamma delta</p></body></html>'
      )
    )
    const result = await enrichFromUrl('https://blog.example.com/post')
    expect(result.imageUrl).toBe('https://cdn.example.com/og.jpg')
    expect(result.wordCount).toBeGreaterThanOrEqual(4)
    expect(mockSafeFetch).toHaveBeenCalledTimes(1)
  })

  it('returns nulls (never throws) when the fetch rejects', async () => {
    mockSafeFetch.mockRejectedValue(new Error('boom'))
    await expect(enrichFromUrl('https://blog.example.com/post')).resolves.toEqual({
      imageUrl: null,
      wordCount: null,
    })
  })

  it('returns nulls for a non-http(s) URL without fetching', async () => {
    expect(await enrichFromUrl('ftp://example.com/x')).toEqual({ imageUrl: null, wordCount: null })
    expect(mockSafeFetch).not.toHaveBeenCalled()
  })
})
