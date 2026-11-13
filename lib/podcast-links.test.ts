import { describe, it, expect, vi, afterEach } from 'vitest'
import { sourceOpenTarget, APPLE_PODCASTS_LIBRARY_URL } from './podcast-links'

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120'

function stubIosBrowserTab() {
  vi.stubGlobal('navigator', { userAgent: IPHONE_UA, maxTouchPoints: 5 })
}

function stubIosStandalonePwa() {
  vi.stubGlobal('navigator', { userAgent: IPHONE_UA, maxTouchPoints: 5, standalone: true })
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((q: string) => ({ matches: true, media: q })))
}

function stubDesktop() {
  vi.stubGlobal('navigator', { userAgent: WINDOWS_UA, maxTouchPoints: 0 })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// The link value is shaped like a real AWC enclosure URL but the secret is fake.
const awc = { platform: 'Askwho Casts', link: 'https://app.askwhocasts.com/f/notasecret/media/x.mp3' }

describe('sourceOpenTarget', () => {
  it('swaps AWC sources to the Apple Podcasts Library universal link on iOS', () => {
    stubIosBrowserTab()
    expect(sourceOpenTarget(awc, true)).toEqual({
      href: APPLE_PODCASTS_LIBRARY_URL,
      label: 'Open in Apple Podcasts',
      applePodcasts: true,
      sublabel: null,
    })
  })

  it('keeps the universal link plain in the iOS standalone PWA (no x-safari-)', () => {
    // x-safari- is mutually exclusive with universal-link handoff (#197);
    // wrapping this href in externalHref would break the app handoff.
    stubIosStandalonePwa()
    expect(sourceOpenTarget(awc, true).href).toBe(APPLE_PODCASTS_LIBRARY_URL)
  })

  it('keeps the MP3 href for AWC sources off iOS', () => {
    stubDesktop()
    expect(sourceOpenTarget(awc, true)).toEqual({
      href: awc.link,
      label: 'Open on Askwho Casts',
      applePodcasts: false,
      sublabel: null,
    })
  })

  it('keeps the MP3 href pre-hydration even on iOS (SSR safety)', () => {
    stubIosBrowserTab()
    expect(sourceOpenTarget(awc, false)).toEqual({
      href: awc.link,
      label: 'Open on Askwho Casts',
      applePodcasts: false,
      sublabel: null,
    })
  })

  it('routes non-AWC platforms through externalHref (x-safari escape in the PWA)', () => {
    stubIosStandalonePwa()
    expect(sourceOpenTarget({ platform: 'Website', link: 'https://example.com/a' }, true)).toEqual({
      href: 'x-safari-https://example.com/a',
      label: 'Open on Website',
      applePodcasts: false,
      sublabel: null,
    })
  })

  it('leaves non-AWC hrefs untouched pre-hydration', () => {
    stubIosStandalonePwa()
    expect(sourceOpenTarget({ platform: 'Website', link: 'https://example.com/a' }, false).href)
      .toBe('https://example.com/a')
  })

  it('returns an empty href for link-less sources', () => {
    stubDesktop()
    expect(sourceOpenTarget({ platform: 'Physical', link: null }, true).href).toBe('')
  })
})

// #245: an item can carry several Spotify episode rows since #237, and the
// SHOW name is what tells them apart. The sublabel only appears when the caller
// says this platform repeats on this item, so single-source items keep the
// clean "Open on Spotify".
describe('sourceOpenTarget sublabel (#245)', () => {
  const spotify = {
    platform: 'Spotify',
    link: 'https://open.spotify.com/episode/abc',
    sourceLabel: 'Astral Codex Ten',
  }

  it('omits the sublabel when not disambiguating, even with a label present', () => {
    stubDesktop()
    expect(sourceOpenTarget(spotify, true).sublabel).toBeNull()
  })

  it('surfaces the show name when disambiguating', () => {
    stubDesktop()
    expect(sourceOpenTarget(spotify, true, true).sublabel).toBe('Astral Codex Ten')
  })

  it('leaves the primary label untouched so the platform still reads plainly', () => {
    stubDesktop()
    expect(sourceOpenTarget(spotify, true, true).label).toBe('Open on Spotify')
  })

  it('omits the sublabel for legacy rows carrying no label', () => {
    // 154 prod rows predate the column; they must never render blank/undefined.
    stubDesktop()
    const target = sourceOpenTarget(
      { platform: 'Spotify', link: 'https://open.spotify.com/episode/abc', sourceLabel: null },
      true,
      true,
    )
    expect(target.sublabel).toBeNull()
  })

  it('omits the sublabel for an absent sourceLabel field', () => {
    stubDesktop()
    expect(
      sourceOpenTarget({ platform: 'Spotify', link: 'https://open.spotify.com/e/a' }, true, true)
        .sublabel,
    ).toBeNull()
  })

  it('treats a whitespace-only label as absent', () => {
    stubDesktop()
    expect(sourceOpenTarget({ ...spotify, sourceLabel: '   ' }, true, true).sublabel).toBeNull()
  })

  it('trims surrounding whitespace off a real label', () => {
    stubDesktop()
    expect(sourceOpenTarget({ ...spotify, sourceLabel: '  AI Article Readings ' }, true, true)
      .sublabel).toBe('AI Article Readings')
  })

  it('keeps the Apple Podcasts branch label-free even when disambiguating', () => {
    // AWC is already platform-distinct and its label is an action, not a
    // platform name — appending a show name there would read as noise (#236).
    stubIosBrowserTab()
    expect(sourceOpenTarget({ ...awc, sourceLabel: 'Askwho Casts' }, true, true)).toEqual({
      href: APPLE_PODCASTS_LIBRARY_URL,
      label: 'Open in Apple Podcasts',
      applePodcasts: true,
      sublabel: null,
    })
  })
})

describe('comments episodes (#368)', () => {
  const comments = { ...awc, sourceLabel: 'Comments' }
  it('names itself on iOS, where other Askwho sources have no sublabel', () => {
    stubIosBrowserTab()
    expect(sourceOpenTarget(comments, true)).toMatchObject({ href: APPLE_PODCASTS_LIBRARY_URL, sublabel: 'Comments' })
    expect(sourceOpenTarget(awc, true, true).sublabel).toBeNull()
  })
  it('names itself elsewhere even when the post has no other Askwho source', () => {
    stubDesktop()
    expect(sourceOpenTarget(comments, true)).toMatchObject({ sublabel: 'Comments', applePodcasts: false })
  })
})
