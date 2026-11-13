// Client-side helpers for opening external content links on iOS (#197, #267).
//
// iOS only performs universal-link handoff (web → native app, e.g. Substack)
// on a genuine user tap of a real <a href> anchor — window.open/location.href
// are excluded — so call sites must render anchors and use externalHref() for
// the href. From the home-screen standalone PWA, non-universal links would
// open the layered in-app browser sheet; the undocumented x-safari- scheme
// prefix escapes to real Safari there. It is mutually exclusive with
// universal-link handoff, so links to apps we want to reach are left untouched.
//
// #267 replaced the per-source predicates (isSubstackLink / isApplePodcastsLink
// / isSpotifyLink) with the UNIVERSAL_LINK_HOSTS registry below, because
// host-wide keep-plain had a bad failure mode: a registered host on an
// UNregistered path was left plain, could not hand off, and therefore landed in
// the in-app sheet — the worst of the three destinations, with no way out.
// Matching on host AND path means a miss falls through to x-safari- and reaches
// real Safari instead.

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  if (/iP(hone|od|ad)/.test(ua)) return true
  // iPadOS 13+ reports a Macintosh UA but is a touch device.
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1
}

// True when running as an installed home-screen web app rather than a browser
// tab. navigator.standalone is the iOS-Safari signal; the display-mode media
// query is the standards-based one (more reliable on iPadOS).
export function isStandalonePwa(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  if ((navigator as { standalone?: boolean }).standalone === true) return true
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches
  )
}

/**
 * One host's universal-link registration, mirroring its real
 * /.well-known/apple-app-site-association file — but deliberately NARROWED to
 * the path shapes this app actually stores in content_sources.
 *
 * Under-matching is cheap and over-matching is not: an unmatched URL falls
 * through to x-safari- and opens in real Safari (acceptable), whereas a URL
 * wrongly kept plain is stranded in the in-app browser sheet (#235). So when in
 * doubt, leave a path shape out.
 */
interface UniversalLinkHost {
  /** App the handoff reaches. Returned by universalLinkTarget(). */
  app: string
  /** Exact hostnames (lowercase). Never suffix-matched — see hostSuffix. */
  hosts?: string[]
  /** Dotted suffix, e.g. '.substack.com'. The leading dot is required so that
   *  a lookalike like `evil-substack.com.attacker.io` cannot match. */
  hostSuffix?: string
  /** AASA-style path globs ('*' = any run, '?' = one char). '*' alone = all. */
  paths: string[]
  /** AASA "NOT" path exclusions, evaluated before `paths`. */
  notPaths?: string[]
  /** Query params that disable handoff (the AASA '?' component form). */
  notQuery?: string[]
  /** URL fragments that disable handoff (the AASA '#' component form). */
  notFragment?: string[]
}

// Substack publication registration. AASA verified 2026-08-24: every
// publication subdomain AND every custom domain serves exactly this set.
const SUBSTACK_PUBLICATION_PATHS = ['/p/*', '/notes/*', '/chat/*']

// Substack publications on custom domains, mapped to their publication slug.
//
// These hosts DO serve Substack's AASA (verified with a direct 200, no -L,
// 2026-08-24) — but that is only half of the universal-link handshake. The
// other half is the Substack app's associated-domains ENTITLEMENT, which is
// baked into the binary at build time and cannot enumerate arbitrary customer
// domains, so iOS never hands these hosts off. Device-confirmed on the ACX
// item that motivated #267, and visible in Substack's own pages: every
// "open in app" button on a custom-domain post routes through
// open.substack.com instead of trusting the custom domain.
//
// So instead of keeping these plain (which strands them in the in-app browser
// sheet), substackAppHref() bridges their /p/* posts to
// open.substack.com/pub/<slug>/p/<post> — Substack's own open-in-app host,
// which registers paths ['*'] and is unambiguously in the app's entitlement.
// Without the app installed, that URL 302s back to the canonical custom-domain
// article (verified 2026-08-27), so nothing is lost.
//
// Slugs are NOT derivable from the hostname (see aisafety, amistrongeryet,
// jasmine…). Each was extracted from the open.substack.com/pub/<slug> links
// embedded in the publication's own post pages, then verified to 302 back to
// its host (2026-08-27).
const SUBSTACK_CUSTOM_PUBS: Record<string, string> = {
  'www.astralcodexten.com': 'astralcodexten',
  'blog.redwoodresearch.org': 'redwoodresearch',
  'www.dwarkesh.com': 'dwarkesh',
  'www.hyperdimensional.co': 'hyperdimensional',
  'www.noahpinion.blog': 'noahpinion',
  'newsletter.safe.ai': 'aisafety',
  'blog.aifutures.org': 'aifutures1',
  'www.planned-obsolescence.org': 'plannedobs',
  'blog.peterwildeford.com': 'peterwildeford',
  'jasmi.news': 'jasmine',
  'secondthoughts.ai': 'amistrongeryet',
  'www.conspicuouscognition.com': 'conspicuouscognition',
  'www.generalist.com': 'thegeneralist',
  'blog.andymasley.com': 'andymasley',
  'newsletter.ai-frontiers.org': 'aifrontiersmedia',
}

// Hosts that look Substack-associated — they match *.substack.com, or carry the
// 'Substack' platform label — but whose AASA is NOT directly reachable, so iOS
// will never hand them off. Checked before everything else: kept plain they
// would strand in the in-app browser sheet, which is strictly worse than the
// Safari the x-safari- escape gives them (#235).
//
// Most are publications that MIGRATED to a custom domain: Substack 301s the
// whole old subdomain, AASA included, so the subdomain itself is dead. The old
// *.substack.com URLs live on in content_sources (23 rows), and the pre-#267
// suffix match kept every one of them plain — this list is what stops that.
//
// The dead subdomain is always <slug>.substack.com, so the list is DERIVED
// from SUBSTACK_CUSTOM_PUBS: every publication in that map has migrated
// (that's why it's in the map), and hand-maintaining a parallel list left 9 of
// 15 dead subdomains strandable through the '.substack.com' suffix entry.
// Old-subdomain rows escape to Safari rather than being bridged — bridging
// them too is a filed follow-up on #267.
const UNASSOCIATED_HOSTS = [
  'blog.ai-futures.org', // 308 -> blog.aifutures.org
  ...Object.values(SUBSTACK_CUSTOM_PUBS).map((slug) => `${slug}.substack.com`),
]

export const UNIVERSAL_LINK_HOSTS: UniversalLinkHost[] = [
  // Substack apex. Its AASA registers a broader set than publications do; this
  // is the reader-facing subset. Notably absent: /home/*, which production has
  // one row of and which therefore must escape to Safari.
  {
    app: 'Substack',
    hosts: ['substack.com'],
    paths: ['/p/*', '/app-link/*', '/notes', '/note/*', '/@*', '/chat', '/chat/*', '/profile/*'],
  },
  // open.substack.com registers '*' — it is Substack's own open-in-app host.
  { app: 'Substack', hosts: ['open.substack.com'], paths: ['*'] },
  // Publication subdomains. Custom domains are deliberately ABSENT: they
  // cannot universal-link (no entitlement coverage) and are bridged through
  // open.substack.com by substackAppHref() instead — see SUBSTACK_CUSTOM_PUBS.
  { app: 'Substack', hostSuffix: '.substack.com', paths: SUBSTACK_PUBLICATION_PATHS },
  // Spotify (#246). Only open.spotify.com is registered; other spotify.com
  // hosts (accounts, www) are not, and must keep their x-safari- escape.
  {
    app: 'Spotify',
    hosts: ['open.spotify.com'],
    paths: ['/episode/*', '/show/*', '/album/*', '/artist/*', '/track/*', '/playlist/*'],
    notPaths: ['/__noul__/*'],
  },
  // Apple Podcasts (#236). Apple returns a zero-byte AASA body to ordinary
  // clients, so this entry is device-verified rather than AASA-derived — the
  // /library universal link was confirmed on-device in #236. Do not narrow it
  // without a fresh device test.
  { app: 'Apple Podcasts', hosts: ['podcasts.apple.com'], paths: ['*'] },
  // YouTube (#267). The real AASA is allow-'/*' minus ~100 creator-studio
  // exclusions; encoding the viewer paths we store is both smaller and safer.
  // The bare youtube.com apex is deliberately absent: it 301-redirects its AASA
  // to www, so it is not associated. Production has 6 apex rows; they escape to
  // Safari rather than being stranded plain.
  {
    app: 'YouTube',
    hosts: ['www.youtube.com', 'm.youtube.com'],
    paths: ['/watch', '/live/*', '/shorts/*'],
    notQuery: ['noapp'],
  },
  { app: 'YouTube', hosts: ['youtu.be'], paths: ['*'], notQuery: ['noapp'] },
  // Goodreads (#267). Its AASA is allow-by-default with NOT exclusions for the
  // various /*deals paths; /book/* is the only shape production stores.
  { app: 'Goodreads', hosts: ['www.goodreads.com'], paths: ['/book/*'] },
  // Audible (#267). The real AASA does NOT register /pd/* — the final path
  // segment must be exactly a 10-character ASIN, which '?' matches one-for-one.
  {
    app: 'Audible',
    hosts: ['www.audible.com'],
    paths: ['/pd/??????????', '/pd/*/??????????', '/pd/*/*/??????????'],
    notQuery: ['noapp'],
    notFragment: ['no_app'],
  },
]

// Match one AASA path glob: '*' matches any run of characters and '?' exactly
// one, per Apple's matching rules; everything else is literal; the whole path
// must match, so '/watch' does not match '/watchlist'. An iterative matcher
// (O(path × pattern)) rather than a translated regex: '/pd/*/*/??????????' as
// ^/pd/.*/.*/..........$ backtracks O(n²) on feed-controlled paths (#281, F18).
function globMatch(pattern: string, path: string): boolean {
  let p = 0
  let t = 0
  let star = -1
  let resume = 0
  while (t < path.length) {
    if (p < pattern.length && pattern[p] === '*') {
      // Checked first: a literal '*' in the path must not consume the wildcard.
      star = p++
      resume = t
    } else if (p < pattern.length && (pattern[p] === '?' || pattern[p] === path[t])) {
      p++
      t++
    } else if (star !== -1) {
      p = star + 1
      t = ++resume
    } else {
      return false
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++
  return p === pattern.length
}

// Longer than any real content URL; refuse to hand these off at all (#281).
const MAX_URL_LENGTH = 2048

function entryMatches(entry: UniversalLinkHost, url: URL): boolean {
  const hostname = url.hostname.toLowerCase()
  const hostOk =
    entry.hosts?.includes(hostname) === true ||
    (entry.hostSuffix !== undefined && hostname.endsWith(entry.hostSuffix))
  if (!hostOk) return false
  if (entry.notQuery?.some((param) => url.searchParams.has(param))) return false
  if (entry.notFragment?.some((f) => url.hash === `#${f}`)) return false
  if (entry.notPaths?.some((glob) => globMatch(glob, url.pathname))) return false
  return entry.paths.some((glob) => globMatch(glob, url.pathname))
}

/**
 * The app iOS would hand this URL off to AS-IS, or null if no registration
 * covers it. Custom-domain Substack publications return null here even though
 * they serve an AASA — the app-side entitlement is missing, so a tap on the
 * raw URL never hands off. substackAppHref() is the bridge for those; use
 * handoffTarget() when you want the destination of the shipped href.
 *
 * The #197 platform-label union is gone for the same reason: a row labelled
 * 'Substack' on an arbitrary custom domain cannot hand off either, and keeping
 * it plain stranded it in the in-app sheet. Unknown custom domains now escape
 * to Safari.
 *
 * Universal links are HTTPS-only, so plain http and malformed URLs are null.
 */
export function universalLinkTarget(url: string): string | null {
  if (url.length > MAX_URL_LENGTH) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  if (UNASSOCIATED_HOSTS.includes(parsed.hostname.toLowerCase())) return null
  for (const entry of UNIVERSAL_LINK_HOSTS) {
    if (entryMatches(entry, parsed)) return entry.app
  }
  return null
}

/**
 * The open.substack.com bridge for a custom-domain Substack post, or null if
 * this is not a known custom-domain /p/* post. See SUBSTACK_CUSTOM_PUBS for
 * why the bridge exists. Query and fragment are dropped — the bridgehead needs
 * neither, and the stored links carry only tracking params there.
 */
export function substackAppHref(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  const slug = SUBSTACK_CUSTOM_PUBS[parsed.hostname.toLowerCase()]
  if (slug === undefined) return null
  const post = parsed.pathname.match(/^\/p\/([^/]+)\/?$/)
  if (post === null) return null
  return `https://open.substack.com/pub/${slug}/p/${post[1]}`
}

/**
 * The app the SHIPPED href hands off to: the bridged URL's target for
 * custom-domain Substack posts, the raw URL's target otherwise. This is what
 * the link lab reports per row (#267).
 */
export function handoffTarget(url: string): string | null {
  return universalLinkTarget(substackAppHref(url) ?? url)
}

/**
 * The href to render for an external content link. Inside the iOS standalone
 * PWA: known custom-domain Substack posts are bridged to open.substack.com
 * (substackAppHref), registered universal links stay plain to reach their
 * apps, and everything else gets the x-safari- scheme prefix so it opens in
 * real Safari instead of the in-app browser sheet. Outside the PWA the URL is
 * always returned unchanged — the bridge is a handoff vehicle, not a canonical
 * URL. Known gap: x-safari- is reportedly a no-op on iOS 16.
 */
export function externalHref(url: string): string {
  if (!/^https?:\/\//.test(url)) return url
  if (!isIos() || !isStandalonePwa()) return url
  const bridged = substackAppHref(url)
  if (bridged !== null) return bridged
  if (universalLinkTarget(url) !== null) return url
  return `x-safari-${url}`
}

/**
 * Imperatively open an external URL in the OS browser (#235). The rendered-anchor
 * path uses externalHref(); this is its counterpart for handoffs that must open a
 * URL from JS (e.g. the copy-then-open reader handoff in lib/reader/handoff.ts).
 *
 * Inside the iOS standalone PWA, window.open routes into the layered in-app
 * browser sheet — the very bug this fixes — so navigate the top window to the
 * x-safari--prefixed href instead, which escapes to real Safari. Everywhere else
 * (desktop, iOS browser tab) window.open('_blank') is correct and keeps the
 * current page intact.
 */
export function openExternal(url: string): void {
  if (isIos() && isStandalonePwa()) {
    window.location.href = externalHref(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}
