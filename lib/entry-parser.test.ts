import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseEntry, isUrl, platformFromDomain, isDegenerateTitle, htmlForClaude } from './entry-parser'
import { UnsafeUrlError } from './safe-fetch'

// The page fetch goes through the SSRF-guarded safeFetch (#206); the YouTube
// oEmbed fetch (fixed host) stays on raw global.fetch. readTextCapped stays
// real, so safeFetch mocks return real Response objects.
vi.mock('./safe-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./safe-fetch')>()
  return { ...actual, safeFetch: vi.fn() }
})

import { safeFetch } from './safe-fetch'
const mockSafeFetch = vi.mocked(safeFetch)

// ---------------------------------------------------------------------------
// isUrl
// ---------------------------------------------------------------------------

describe('isUrl', () => {
  it('returns true for http URLs', () => {
    expect(isUrl('http://example.com')).toBe(true)
  })

  it('returns true for https URLs', () => {
    expect(isUrl('https://thezvi.substack.com/p/some-post')).toBe(true)
  })

  it('returns false for plain text', () => {
    expect(isUrl('The Great Gatsby')).toBe(false)
  })

  it('returns false for partial URLs', () => {
    expect(isUrl('example.com')).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(isUrl('')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// platformFromDomain
// ---------------------------------------------------------------------------

describe('platformFromDomain', () => {
  it('identifies Substack', () => {
    expect(platformFromDomain('https://thezvi.substack.com/p/post')).toBe('Substack')
  })

  it('identifies LessWrong', () => {
    expect(platformFromDomain('https://www.lesswrong.com/posts/abc123')).toBe('LessWrong')
  })

  it('identifies Spotify', () => {
    expect(platformFromDomain('https://open.spotify.com/episode/123')).toBe('Spotify')
  })

  it('identifies Audible', () => {
    expect(platformFromDomain('https://www.audible.com/pd/book')).toBe('Audible')
  })

  it('identifies YouTube (youtube.com)', () => {
    expect(platformFromDomain('https://www.youtube.com/watch?v=abc')).toBe('YouTube')
  })

  it('identifies YouTube (youtu.be)', () => {
    expect(platformFromDomain('https://youtu.be/abc?si=xyz')).toBe('YouTube')
  })

  it('does not treat lookalike domains as YouTube', () => {
    expect(platformFromDomain('https://notyoutube.com/watch?v=abc')).toBe('Website')
    expect(platformFromDomain('https://youtube.com.evil.example/watch')).toBe('Website')
  })

  it('defaults to Website', () => {
    expect(platformFromDomain('https://example.com/article')).toBe('Website')
  })
})

// ---------------------------------------------------------------------------
// isDegenerateTitle
// ---------------------------------------------------------------------------

describe('isDegenerateTitle', () => {
  it('flags the bot-walled YouTube page title "- YouTube" (#176)', () => {
    expect(isDegenerateTitle('- YouTube')).toBe(true)
  })

  it('flags a bare site name "YouTube"', () => {
    expect(isDegenerateTitle('YouTube')).toBe(true)
  })

  it('flags empty and separator-only titles', () => {
    expect(isDegenerateTitle('')).toBe(true)
    expect(isDegenerateTitle('   ')).toBe(true)
    expect(isDegenerateTitle('- ')).toBe(true)
  })

  it('accepts real titles, including ones mentioning YouTube', () => {
    expect(isDegenerateTitle('My Video - YouTube Tips')).toBe(false)
    expect(isDegenerateTitle('AI Pioneer Geoffrey Hinton: AI Is Conscious')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseEntry — URL mode
// ---------------------------------------------------------------------------

describe('parseEntry with URL', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('extracts metadata from a URL with OG tags', async () => {
    const mockHtml = `
      <html>
        <head>
          <meta property="og:title" content="Test Article Title" />
          <meta property="og:site_name" content="Test Blog" />
          <meta name="author" content="Jane Doe" />
        </head>
        <body>Content</body>
      </html>
    `

    mockSafeFetch.mockResolvedValue(new Response(mockHtml, { status: 200 }))

    const result = await parseEntry('https://example.com/test-article')

    expect(result.title).toBe('Test Article Title')
    expect(result.author).toBe('Jane Doe')
    expect(result.platform).toBe('Website')
    expect(result.link).toBe('https://example.com/test-article')
  })

  it('falls back to <title> tag when no OG title', async () => {
    const mockHtml = `
      <html>
        <head><title>Fallback Title - Site Name</title></head>
        <body>Content</body>
      </html>
    `

    mockSafeFetch.mockResolvedValue(new Response(mockHtml, { status: 200 }))

    const result = await parseEntry('https://example.com/test')

    expect(result.title).toBe('Fallback Title - Site Name')
  })

  it('identifies Substack URLs correctly', async () => {
    const mockHtml = `
      <html>
        <head>
          <meta property="og:title" content="My Post" />
          <meta name="author" content="Zvi" />
        </head>
      </html>
    `

    mockSafeFetch.mockResolvedValue(new Response(mockHtml, { status: 200 }))

    const result = await parseEntry('https://thezvi.substack.com/p/my-post')
    expect(result.platform).toBe('Substack')
  })

  it('throws on failed fetch', async () => {
    mockSafeFetch.mockResolvedValue(new Response('nope', { status: 404 }))

    await expect(parseEntry('https://example.com/not-found'))
      .rejects.toThrow()
  })

  it('propagates UnsafeUrlError when the guard blocks the URL (SSRF, #206)', async () => {
    mockSafeFetch.mockRejectedValue(new UnsafeUrlError('Blocked address: 169.254.169.254'))

    await expect(parseEntry('http://169.254.169.254/latest/meta-data/'))
      .rejects.toThrow(UnsafeUrlError)
  })
})

// ---------------------------------------------------------------------------
// parseEntry — YouTube URLs via oEmbed (#176)
//
// YouTube bot-walls datacenter IPs: the page fetch returns HTML with no OG tags
// and a literal "- YouTube" <title>, so scraping produces junk metadata. The
// oEmbed endpoint (no API key) returns the real title + channel name.
// ---------------------------------------------------------------------------

describe('parseEntry with YouTube URL (oEmbed)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses the oEmbed endpoint for youtu.be links', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ title: 'Real Video Title', author_name: 'Channel Name' }),
    })
    global.fetch = mockFetch as unknown as typeof fetch

    const result = await parseEntry('https://youtu.be/abc123?si=xyz')

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('https://www.youtube.com/oembed?url='),
      expect.anything()
    )
    expect(result.title).toBe('Real Video Title')
    expect(result.author).toBe('Channel Name')
    expect(result.platform).toBe('YouTube')
    expect(result.link).toBe('https://youtu.be/abc123?si=xyz')
  })

  it('uses the oEmbed endpoint for youtube.com/watch links', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ title: 'Watch Title', author_name: 'Creator' }),
    })
    global.fetch = mockFetch as unknown as typeof fetch

    const result = await parseEntry('https://www.youtube.com/watch?v=abc123')

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('oembed'),
      expect.anything()
    )
    expect(result.title).toBe('Watch Title')
    expect(result.platform).toBe('YouTube')
  })

  it('falls back to page scraping when oEmbed fails', async () => {
    const mockHtml = `
      <html>
        <head><meta property="og:title" content="Scraped Title" /></head>
        <body>Content</body>
      </html>
    `
    // oEmbed (raw fetch) → 404 (e.g. private/removed video)
    const mockFetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 404 })
    global.fetch = mockFetch as unknown as typeof fetch
    // Page fetch fallback goes through safeFetch
    mockSafeFetch.mockResolvedValue(new Response(mockHtml, { status: 200 }))

    const result = await parseEntry('https://youtu.be/gone123')

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockSafeFetch).toHaveBeenCalledTimes(1)
    expect(result.title).toBe('Scraped Title')
    expect(result.platform).toBe('YouTube')
  })

  it('does not call oEmbed for non-YouTube URLs', async () => {
    const mockHtml = `
      <html><head><meta property="og:title" content="Article" /></head></html>
    `
    const mockFetch = vi.fn()
    global.fetch = mockFetch as unknown as typeof fetch
    mockSafeFetch.mockResolvedValue(new Response(mockHtml, { status: 200 }))

    await parseEntry('https://example.com/article')

    // The oEmbed endpoint (raw fetch) is never touched for non-YouTube URLs
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('attacker HTML is scanned in linear time (#281 F11)', () => {
  it('htmlForClaude trims <head> + body snippet without backtracking', () => {
    const start = performance.now()
    htmlForClaude('<head>'.repeat(100_000))
    htmlForClaude('<head'.repeat(100_000))
    htmlForClaude(`<head></head><body${' x'.repeat(100_000)}`)
    expect(performance.now() - start).toBeLessThan(100)
  })

  it('htmlForClaude keeps the head and the first 2000 chars of body', () => {
    const out = htmlForClaude(`<html><head><title>T</title></head><body class="b">${'w'.repeat(5000)}</body>`)
    expect(out).toBe(`<head><title>T</title></head>\n<body>${'w'.repeat(2000)}</body>`)
  })

  it('the programmatic fallback handles pathological meta/title markup quickly', async () => {
    const saved = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const html = `${'<meta '.repeat(40_000)}${'<title'.repeat(40_000)}`
      mockSafeFetch.mockResolvedValue(new Response(html, { status: 200 }))
      const start = performance.now()
      const result = await parseEntry('https://example.com/evil')
      expect(performance.now() - start).toBeLessThan(500)
      expect(result.title).toBe('https://example.com/evil')
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved
    }
  })
})
