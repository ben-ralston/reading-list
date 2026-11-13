import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  isIos,
  isStandalonePwa,
  universalLinkTarget,
  substackAppHref,
  externalHref,
  openExternal,
} from './links'

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120'

const matchMediaMatching = (matches: boolean) =>
  vi.fn().mockImplementation((query: string) => ({ matches, media: query }))

function stubContext({
  ua = WINDOWS_UA,
  maxTouchPoints = 0,
  standalone,
  displayModeStandalone = false,
}: {
  ua?: string
  maxTouchPoints?: number
  standalone?: boolean
  displayModeStandalone?: boolean
}) {
  vi.stubGlobal('navigator', { userAgent: ua, maxTouchPoints, standalone })
  vi.stubGlobal('matchMedia', matchMediaMatching(displayModeStandalone))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isIos', () => {
  it('is true on iPhone', () => {
    stubContext({ ua: IPHONE_UA, maxTouchPoints: 5 })
    expect(isIos()).toBe(true)
  })

  it('is true on iPadOS reporting a Macintosh UA with touch points', () => {
    stubContext({ ua: MAC_UA, maxTouchPoints: 5 })
    expect(isIos()).toBe(true)
  })

  it('is false on a desktop Mac (no touch points)', () => {
    stubContext({ ua: MAC_UA, maxTouchPoints: 0 })
    expect(isIos()).toBe(false)
  })

  it('is false on a non-Apple platform', () => {
    stubContext({ ua: WINDOWS_UA })
    expect(isIos()).toBe(false)
  })
})

describe('isStandalonePwa', () => {
  it('is true when navigator.standalone is true (iOS home-screen web app)', () => {
    stubContext({ ua: IPHONE_UA, maxTouchPoints: 5, standalone: true })
    expect(isStandalonePwa()).toBe(true)
  })

  it('is true when the display-mode: standalone media query matches', () => {
    stubContext({ ua: IPHONE_UA, maxTouchPoints: 5, displayModeStandalone: true })
    expect(isStandalonePwa()).toBe(true)
  })

  it('is false in a regular browser tab', () => {
    stubContext({ ua: IPHONE_UA, maxTouchPoints: 5 })
    expect(isStandalonePwa()).toBe(false)
  })

  it('is false (not a crash) when matchMedia is unavailable', () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE_UA, maxTouchPoints: 5 })
    vi.stubGlobal('matchMedia', undefined)
    expect(isStandalonePwa()).toBe(false)
  })
})

describe('universalLinkTarget', () => {
  // Substack. AASA verified 2026-08-24: the apex registers a broad path set,
  // while publication subdomains and custom domains register only
  // /p/*, /notes/*, /chat/*. open.substack.com registers everything.
  describe('Substack', () => {
    it('matches publication subdomains on registered paths', () => {
      expect(universalLinkTarget('https://freddiedeboer.substack.com/p/some-post')).toBe('Substack')
      expect(universalLinkTarget('https://thezvi.substack.com/p/ai-135')).toBe('Substack')
    })

    it('matches the substack.com apex path set and open.substack.com', () => {
      expect(universalLinkTarget('https://substack.com/@someone/p/1')).toBe('Substack')
      expect(universalLinkTarget('https://substack.com/app-link/post?token=x')).toBe('Substack')
      expect(universalLinkTarget('https://open.substack.com/pub/x/p/y')).toBe('Substack')
    })

    // Custom-domain publications serve Substack's AASA, but that is only half
    // the handshake: the app's associated-domains entitlement cannot enumerate
    // customer domains, so iOS never hands them off — device-confirmed on the
    // ACX item that motivated #267. They are bridged via substackAppHref()
    // instead of being kept plain (which stranded them in the in-app sheet).
    it('is null for custom-domain publications (the entitlement half is missing)', () => {
      expect(universalLinkTarget('https://www.dwarkesh.com/p/x')).toBe(null)
      expect(universalLinkTarget('https://www.astralcodexten.com/p/x')).toBe(null)
      expect(universalLinkTarget('https://blog.redwoodresearch.org/p/x')).toBe(null)
      expect(universalLinkTarget('https://www.thefp.com/p/some-post')).toBe(null)
    })

    // Finding 5 (#267): a registered host on an UNregistered path cannot hand
    // off, so it must not be kept plain — otherwise it lands in the in-app sheet.
    it('is null on unregistered paths even for registered Substack hosts', () => {
      expect(universalLinkTarget('https://substack.com/home/post/p-1')).toBe(null)
      expect(universalLinkTarget('https://thezvi.substack.com/archive')).toBe(null)
    })

    // Apple requires the AASA over HTTPS with NO redirect. blog.ai-futures.org
    // 308s to blog.aifutures.org, so it is not associated and must not be kept
    // plain — not even via the Substack platform label.
    it('is null for a Substack host whose AASA is only reachable via a redirect', () => {
      expect(universalLinkTarget('https://blog.ai-futures.org/p/grading-ai-2027s')).toBe(null)
    })

    // Publications that moved to a custom domain: Substack 301s the whole old
    // subdomain including its AASA, so the *.substack.com suffix match must not
    // claim them. Pre-#267 every one of these was kept plain and stranded.
    it('is null for migrated publication subdomains that now redirect', () => {
      expect(universalLinkTarget('https://astralcodexten.substack.com/p/x')).toBe(null)
      expect(universalLinkTarget('https://dwarkesh.substack.com/p/x')).toBe(null)
      expect(universalLinkTarget('https://redwoodresearch.substack.com/p/x')).toBe(null)
      // Every custom-domain publication's old <slug>.substack.com subdomain is
      // dead the same way — the deny-list is derived from the slug map, so an
      // unlisted one can never strand through the suffix entry (review of
      // 6c337c4, finding 1).
      expect(universalLinkTarget('https://noahpinion.substack.com/p/x')).toBe(null)
      expect(universalLinkTarget('https://aisafety.substack.com/p/x')).toBe(null)
      expect(universalLinkTarget('https://amistrongeryet.substack.com/p/x')).toBe(null)
      expect(universalLinkTarget('https://andymasley.substack.com/p/x')).toBe(null)
      // ...while the live subdomains they sit alongside are unaffected.
      expect(universalLinkTarget('https://thezvi.substack.com/p/x')).toBe('Substack')
      expect(universalLinkTarget('https://epochai.substack.com/p/x')).toBe('Substack')
    })

    it('does not match lookalike hostnames', () => {
      expect(universalLinkTarget('https://evil-substack.com.attacker.io/p/x')).toBe(null)
      expect(universalLinkTarget('https://notsubstack.com/p/x')).toBe(null)
      expect(universalLinkTarget('https://substack.com.evil.test/p/x')).toBe(null)
    })
  })

  describe('Spotify', () => {
    it('is Spotify for the open.spotify.com links sync stores', () => {
      expect(universalLinkTarget('https://open.spotify.com/episode/abc123')).toBe('Spotify')
      expect(universalLinkTarget('https://open.spotify.com/show/xyz?si=1')).toBe('Spotify')
    })

    // Only open.spotify.com is AASA-registered — anything else must keep its
    // x-safari- escape (#235, #246).
    it('is null for other spotify.com hosts, which are not universal links', () => {
      expect(universalLinkTarget('https://spotify.com/episode/abc123')).toBe(null)
      expect(universalLinkTarget('https://accounts.spotify.com/login')).toBe(null)
      expect(universalLinkTarget('https://www.spotify.com/us/')).toBe(null)
    })

    it('honours the AASA NOT /__noul__/* exclusion', () => {
      expect(universalLinkTarget('https://open.spotify.com/__noul__/episode/a')).toBe(null)
    })

    it('is null for look-alike hostnames', () => {
      expect(universalLinkTarget('https://notspotify.com/episode/abc')).toBe(null)
      expect(universalLinkTarget('https://open.spotify.com.evil.test/episode/abc')).toBe(null)
    })
  })

  describe('Apple Podcasts', () => {
    // Apple serves a zero-byte AASA to ordinary clients, so this entry stays
    // broad and is device-verified via #236 rather than AASA-derived.
    it('matches the Library universal link and episode deep links', () => {
      expect(universalLinkTarget('https://podcasts.apple.com/library')).toBe('Apple Podcasts')
      expect(universalLinkTarget('https://podcasts.apple.com/us/podcast/x/id123?i=456')).toBe('Apple Podcasts')
    })
  })

  describe('YouTube (#267 Finding 3)', () => {
    it('matches watch URLs on the www/m hosts and youtu.be short links', () => {
      expect(universalLinkTarget('https://www.youtube.com/watch?v=abc')).toBe('YouTube')
      expect(universalLinkTarget('https://m.youtube.com/watch?v=abc')).toBe('YouTube')
      expect(universalLinkTarget('https://youtu.be/p7t1Q_p2gZs')).toBe('YouTube')
      expect(universalLinkTarget('https://www.youtube.com/live/abc')).toBe('YouTube')
    })

    // The bare apex 301s its AASA to www, so it is not associated.
    it('is null for the bare youtube.com apex, whose AASA redirects', () => {
      expect(universalLinkTarget('https://youtube.com/watch?v=abc')).toBe(null)
    })

    it('honours the AASA exclusions (/yt/* and the noapp query param)', () => {
      expect(universalLinkTarget('https://www.youtube.com/yt/about')).toBe(null)
      expect(universalLinkTarget('https://www.youtube.com/watch?v=abc&noapp=1')).toBe(null)
    })
  })

  describe('Goodreads (#267 Finding 3)', () => {
    it('matches book pages', () => {
      expect(universalLinkTarget('https://www.goodreads.com/book/show/123.Title')).toBe('Goodreads')
    })

    it('is null for the deal paths the AASA excludes', () => {
      expect(universalLinkTarget('https://www.goodreads.com/deals')).toBe(null)
      expect(universalLinkTarget('https://www.goodreads.com/ebook-deals/x')).toBe(null)
    })
  })

  describe('Audible (#267 Finding 3)', () => {
    // The AASA registers /pd/<10-char ASIN>, /pd/*/<ASIN> and /pd/*/*/<ASIN> —
    // NOT a bare /pd/*. The trailing segment length is load-bearing.
    it('matches product-detail pages ending in a 10-character ASIN', () => {
      expect(universalLinkTarget('https://www.audible.com/pd/B0DF371HQM')).toBe('Audible')
      expect(universalLinkTarget('https://www.audible.com/pd/Some-Book/B0DF371HQM')).toBe('Audible')
    })

    it('is null when the trailing segment is not a 10-character ASIN', () => {
      expect(universalLinkTarget('https://www.audible.com/pd/B0ABCDEFG')).toBe(null)
      expect(universalLinkTarget('https://www.audible.com/pd/x/B01')).toBe(null)
    })

    it('honours the noapp opt-out param and the #no_app fragment', () => {
      expect(universalLinkTarget('https://www.audible.com/pd/B0DF371HQM?noapp=1')).toBe(null)
      expect(universalLinkTarget('https://www.audible.com/pd/B0DF371HQM#no_app')).toBe(null)
    })
  })

  describe('non-app platforms stay unmatched (#267 Finding 4)', () => {
    // These serve no applinks AASA (nytimes.com has webcredentials only), so
    // they must fall through to the x-safari- escape and reach real Safari.
    it.each([
      'https://www.lesswrong.com/posts/abc/title',
      'https://www.greaterwrong.com/posts/abc/title',
      'https://forum.effectivealtruism.org/posts/abc',
      'https://en.wikipedia.org/wiki/Thing',
      'https://80000hours.org/podcast/episodes/x',
      'https://www.nytimes.com/column/ezra-klein-podcast',
      'https://www.thisamericanlife.org/877',
      'https://app.askwhocasts.com/f/abc.mp3',
    ])('is null for %s', (url) => {
      expect(universalLinkTarget(url)).toBe(null)
    })
  })

  describe('hard invariants', () => {
    it('is null over plain http (universal links are HTTPS-only)', () => {
      expect(universalLinkTarget('http://open.spotify.com/episode/abc123')).toBe(null)
      expect(universalLinkTarget('http://thezvi.substack.com/p/x')).toBe(null)
    })

    it('is null for malformed URLs', () => {
      expect(universalLinkTarget('not a url')).toBe(null)
      expect(universalLinkTarget('')).toBe(null)
    })

    it('is case-insensitive on the hostname', () => {
      expect(universalLinkTarget('https://Open.Spotify.COM/episode/abc')).toBe('Spotify')
    })
  })
})

describe('universalLinkTarget ReDoS bounds (#281 F18)', () => {
  it('matches multi-star globs in linear time on long feed-controlled paths', () => {
    const start = performance.now()
    universalLinkTarget(`https://www.audible.com/pd/${'a/'.repeat(30_000)}x`)
    universalLinkTarget(`https://www.audible.com/pd/${'a'.repeat(60_000)}`)
    expect(performance.now() - start).toBeLessThan(100)
  })

  it('never hands off absurdly long URLs', () => {
    expect(universalLinkTarget(`https://www.audible.com/pd/${'x/'.repeat(2000)}B0DF371HQM`)).toBe(null)
  })

  it('treats a literal * in the URL path as an ordinary character', () => {
    expect(universalLinkTarget('https://open.spotify.com/episode/*abc')).toBe('Spotify')
  })

  it('keeps glob semantics: * spans segments, ? is exactly one char', () => {
    expect(universalLinkTarget('https://www.audible.com/pd/a/b/B0DF371HQM')).toBe('Audible')
    expect(universalLinkTarget('https://www.audible.com/pd/a/b/B0DF371HQ')).toBe(null)
  })
})

describe('substackAppHref', () => {
  it('rewrites known custom-domain posts to the open.substack.com bridgehead', () => {
    expect(substackAppHref('https://www.astralcodexten.com/p/some-post')).toBe(
      'https://open.substack.com/pub/astralcodexten/p/some-post',
    )
    // Slugs are NOT derivable from the hostname — these three prove the map is
    // load-bearing (extracted from each publication's own pages, 2026-08-27).
    expect(substackAppHref('https://newsletter.safe.ai/p/x')).toBe(
      'https://open.substack.com/pub/aisafety/p/x',
    )
    expect(substackAppHref('https://secondthoughts.ai/p/x')).toBe(
      'https://open.substack.com/pub/amistrongeryet/p/x',
    )
    expect(substackAppHref('https://www.generalist.com/p/x')).toBe(
      'https://open.substack.com/pub/thegeneralist/p/x',
    )
    // aifutures1 looks like a typo next to blog.ai-futures.org but is the real
    // slug — this pin makes the suite fail loudly if anyone "corrects" it.
    expect(substackAppHref('https://blog.aifutures.org/p/x')).toBe(
      'https://open.substack.com/pub/aifutures1/p/x',
    )
  })

  it('drops query and fragment — the bridgehead needs neither', () => {
    expect(substackAppHref('https://www.dwarkesh.com/p/x?utm_source=rss#comments')).toBe(
      'https://open.substack.com/pub/dwarkesh/p/x',
    )
  })

  it('is null for anything that is not a known custom-domain post', () => {
    expect(substackAppHref('https://www.thefp.com/p/x')).toBe(null) // unknown host
    expect(substackAppHref('https://thezvi.substack.com/p/x')).toBe(null) // subdomains hand off directly
    expect(substackAppHref('https://www.dwarkesh.com/about')).toBe(null) // non-post path
    expect(substackAppHref('https://www.dwarkesh.com/p/x/comments')).toBe(null) // deeper path
    expect(substackAppHref('http://www.dwarkesh.com/p/x')).toBe(null) // https only
    expect(substackAppHref('not a url')).toBe(null)
  })
})

describe('externalHref', () => {
  const IOS_STANDALONE = { ua: IPHONE_UA, maxTouchPoints: 5, standalone: true }

  it('returns the URL unchanged outside the iOS standalone PWA', () => {
    stubContext({ ua: IPHONE_UA, maxTouchPoints: 5 }) // iOS browser tab
    expect(externalHref('https://example.com/a')).toBe('https://example.com/a')
    stubContext({ ua: WINDOWS_UA, displayModeStandalone: true }) // non-iOS PWA
    expect(externalHref('https://example.com/a')).toBe('https://example.com/a')
  })

  it('prefixes x-safari- for non-Substack links in the iOS standalone PWA', () => {
    stubContext(IOS_STANDALONE)
    expect(externalHref('https://example.com/a?b=c')).toBe('x-safari-https://example.com/a?b=c')
    expect(externalHref('http://example.com/a')).toBe('x-safari-http://example.com/a')
  })

  it('leaves Substack links unchanged in the iOS standalone PWA (universal link handoff)', () => {
    stubContext(IOS_STANDALONE)
    expect(externalHref('https://pub.substack.com/p/x')).toBe('https://pub.substack.com/p/x')
  })

  it('leaves Apple Podcasts links unchanged in the iOS standalone PWA (universal link handoff, #236)', () => {
    stubContext(IOS_STANDALONE)
    expect(externalHref('https://podcasts.apple.com/library')).toBe('https://podcasts.apple.com/library')
    expect(externalHref('https://podcasts.apple.com/us/podcast/x/id123?i=456')).toBe('https://podcasts.apple.com/us/podcast/x/id123?i=456')
  })

  it('leaves Spotify links unchanged in the iOS standalone PWA (universal link handoff, #246)', () => {
    stubContext(IOS_STANDALONE)
    expect(externalHref('https://open.spotify.com/episode/abc123')).toBe(
      'https://open.spotify.com/episode/abc123',
    )
  })

  // Custom-domain publications cannot universal-link (see substackAppHref), so
  // their post links are bridged to open.substack.com — Substack's own
  // open-in-app host, which unambiguously CAN hand off. This replaces keeping
  // them plain, which stranded them in the in-app sheet (#267 device report).
  it('bridges custom-domain Substack posts to open.substack.com in the iOS PWA', () => {
    stubContext(IOS_STANDALONE)
    expect(externalHref('https://www.astralcodexten.com/p/highlights-from-the-comments-on-the-491')).toBe(
      'https://open.substack.com/pub/astralcodexten/p/highlights-from-the-comments-on-the-491',
    )
    expect(externalHref('https://www.dwarkesh.com/p/bits-per-sample')).toBe(
      'https://open.substack.com/pub/dwarkesh/p/bits-per-sample',
    )
  })

  it('does not bridge outside the iOS standalone PWA', () => {
    stubContext({ ua: IPHONE_UA, maxTouchPoints: 5 }) // iOS browser tab
    expect(externalHref('https://www.astralcodexten.com/p/x')).toBe('https://www.astralcodexten.com/p/x')
    stubContext({ ua: WINDOWS_UA })
    expect(externalHref('https://www.astralcodexten.com/p/x')).toBe('https://www.astralcodexten.com/p/x')
  })

  it('escapes unknown custom domains and non-post paths to Safari', () => {
    stubContext(IOS_STANDALONE)
    expect(externalHref('https://www.thefp.com/p/x')).toBe('x-safari-https://www.thefp.com/p/x')
    expect(externalHref('https://www.dwarkesh.com/about')).toBe('x-safari-https://www.dwarkesh.com/about')
  })

  // Finding 5 (#267): host-wide keep-plain used to strand unregistered paths in
  // the in-app browser sheet. They must now escape to Safari instead.
  it('escapes to Safari on unregistered paths of otherwise-registered hosts', () => {
    stubContext(IOS_STANDALONE)
    expect(externalHref('https://substack.com/home/post/p-1')).toBe(
      'x-safari-https://substack.com/home/post/p-1',
    )
    expect(externalHref('https://www.youtube.com/yt/about')).toBe('x-safari-https://www.youtube.com/yt/about')
  })

  // Finding 3 (#267): these are AASA-registered but were being forced to Safari.
  it('leaves YouTube, Goodreads and Audible links plain in the iOS standalone PWA', () => {
    stubContext(IOS_STANDALONE)
    expect(externalHref('https://www.youtube.com/watch?v=abc')).toBe('https://www.youtube.com/watch?v=abc')
    expect(externalHref('https://youtu.be/abc')).toBe('https://youtu.be/abc')
    expect(externalHref('https://www.goodreads.com/book/show/1.T')).toBe('https://www.goodreads.com/book/show/1.T')
    expect(externalHref('https://www.audible.com/pd/B0DF371HQM')).toBe('https://www.audible.com/pd/B0DF371HQM')
  })

  // Finding 4 (#267): no native app, so these must reach real Safari.
  it('escapes platforms with no native app to Safari', () => {
    stubContext(IOS_STANDALONE)
    expect(externalHref('https://www.lesswrong.com/posts/a/b')).toBe(
      'x-safari-https://www.lesswrong.com/posts/a/b',
    )
  })

  it('leaves non-http(s) values unchanged even in the iOS standalone PWA', () => {
    stubContext(IOS_STANDALONE)
    expect(externalHref('')).toBe('')
    expect(externalHref('spotify:episode:abc')).toBe('spotify:episode:abc')
  })
})

describe('openExternal', () => {
  const IOS_STANDALONE = { ua: IPHONE_UA, maxTouchPoints: 5, standalone: true }
  let openSpy: ReturnType<typeof vi.fn>
  let location: { href: string }

  function stubWindow(ctx: Parameters<typeof stubContext>[0]) {
    stubContext(ctx)
    openSpy = vi.fn()
    location = { href: 'https://app.local/queue' }
    vi.stubGlobal('window', {
      open: openSpy,
      location,
      matchMedia: matchMediaMatching(ctx.displayModeStandalone ?? false),
    })
  }

  it('navigates the top window to the x-safari- href inside the iOS standalone PWA', () => {
    // window.open routes into the layered in-app browser sheet there (#235),
    // so the imperative open must use location.href with the escape scheme.
    stubWindow(IOS_STANDALONE)
    openExternal('https://app.askwhocasts.com/')
    expect(location.href).toBe('x-safari-https://app.askwhocasts.com/')
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('uses window.open in a normal browser tab (desktop ElevenReader path)', () => {
    stubWindow({ ua: WINDOWS_UA })
    openExternal('https://elevenreader.io/')
    expect(openSpy).toHaveBeenCalledWith('https://elevenreader.io/', '_blank', 'noopener,noreferrer')
    expect(location.href).toBe('https://app.local/queue')
  })

  it('uses window.open in an iOS browser tab (not standalone)', () => {
    stubWindow({ ua: IPHONE_UA, maxTouchPoints: 5 })
    openExternal('https://app.askwhocasts.com/')
    expect(openSpy).toHaveBeenCalledWith('https://app.askwhocasts.com/', '_blank', 'noopener,noreferrer')
    expect(location.href).toBe('https://app.local/queue')
  })
})
