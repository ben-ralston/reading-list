/**
 * Feed-card enrichment (#167): derive a preview thumbnail and read/listen length
 * signals for a queue item from the data we already fetch, with a best-effort
 * og:image scrape as a fallback.
 *
 * Two entry points:
 * - enrichFromRssItem(item): synchronous, cheap signals only (no network) —
 *   YouTube-derived thumbnail, RSS enclosure / itunes:image / media:thumbnail,
 *   word count from content:encoded, itunes:duration. Used during RSS parse.
 * - enrichFromUrl(url): asynchronous fallback — fetches the article HTML once and
 *   scrapes og:image + a rough word count. Used when the cheap path found no image
 *   (create path) and by the backfill.
 *
 * Everything here is resilient by contract: network helpers go through
 * safeFetch (http(s) only, private/internal addresses blocked — #281 F5), do not
 * follow redirects, bound the request with a timeout, cap the response body, and
 * NEVER throw — they return nulls on any failure so a single bad feed can't break
 * sync. Only the og:image URL string is ever returned to callers, never the
 * fetched body. HTML is scanned in linear time (lib/html-scan.ts, #281 ReDoS).
 */

import { findTags, getAttribute, stripTags } from '@/lib/html-scan'
import { readTextCapped, safeFetch } from '@/lib/safe-fetch'
import type { RssItem } from './parser'

const YT_THUMB = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
const FETCH_TIMEOUT_MS = 5000
const MAX_HTML_BYTES = 512 * 1024
const USER_AGENT =
  'Mozilla/5.0 (compatible; reading-list/1.0)'

export interface RssEnrichment {
  imageUrl: string | null
  wordCount: number | null
  durationSeconds: number | null
}

export interface UrlEnrichment {
  imageUrl: string | null
  wordCount: number | null
}

/**
 * Derive a YouTube thumbnail URL from a video link. Handles watch?v=, youtu.be/,
 * and /shorts/ forms. Returns null for anything that isn't a recognizable YouTube
 * video URL.
 */
export function deriveYouTubeThumbnail(link: string | null | undefined): string | null {
  if (!link) return null
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return null
  }
  const host = url.hostname.replace(/^www\./, '')
  let id: string | null = null
  if (host === 'youtu.be') {
    id = url.pathname.slice(1).split('/')[0] || null
  } else if (host === 'youtube.com' || host === 'm.youtube.com') {
    if (url.pathname === '/watch') {
      id = url.searchParams.get('v')
    } else if (url.pathname.startsWith('/shorts/')) {
      id = url.pathname.split('/')[2] || null
    } else if (url.pathname.startsWith('/embed/')) {
      id = url.pathname.split('/')[2] || null
    }
  }
  if (!id || !/^[\w-]{6,}$/.test(id)) return null
  return YT_THUMB(id)
}

/** Return the value only if it's an absolute http(s) URL; else null. Rejects
 * relative paths ("/img/x.png") and protocol-relative ("//cdn/x.jpg") so we never
 * store an image URL that would resolve against the app origin (#167 review). */
function absoluteHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    const u = new URL(trimmed)
    return u.protocol === 'http:' || u.protocol === 'https:' ? trimmed : null
  } catch {
    return null
  }
}

/** Pull a string url out of a value that may be a string, {url}, or {$:{url}}. */
function extractUrl(value: unknown): string | null {
  if (!value) return null
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (typeof obj.url === 'string') return obj.url.trim() || null
    const dollar = obj.$ as Record<string, unknown> | undefined
    if (dollar && typeof dollar.url === 'string') return dollar.url.trim() || null
  }
  return null
}

/**
 * Find a thumbnail in the cheap RSS fields: image enclosure → itunes:image →
 * media:thumbnail / media:content. Audio enclosures (podcasts) are ignored here;
 * those items get their art from itunes:image.
 */
export function imageFromRssItem(item: RssItem): string | null {
  const enclosure = item.enclosure as { url?: string; type?: string } | undefined
  if (enclosure?.url && enclosure.type?.startsWith('image/')) {
    const url = absoluteHttpUrl(enclosure.url)
    if (url) return url
  }
  const itunes = item.itunes as { image?: unknown } | undefined
  const itunesImage = absoluteHttpUrl(extractUrl(itunes?.image))
  if (itunesImage) return itunesImage

  const media = absoluteHttpUrl(extractUrl(item['media:thumbnail']) ?? extractUrl(item['media:content']))
  if (media) return media

  return null
}

/**
 * Parse an itunes:duration value (HH:MM:SS, MM:SS, or a plain seconds
 * string/number) into whole seconds. Returns null for empty/garbage input.
 */
export function parseItunesDuration(raw: unknown): number | null {
  if (raw == null) return null

  let seconds: number | null = null
  if (typeof raw === 'number') {
    seconds = Number.isFinite(raw) ? Math.round(raw) : null
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return null
    if (trimmed.includes(':')) {
      const parts = trimmed.split(':').map((p) => Number(p))
      seconds = parts.some((p) => !Number.isFinite(p))
        ? null
        : parts.reduce((acc, p) => acc * 60 + p, 0)
    } else {
      const n = Number(trimmed)
      seconds = Number.isFinite(n) ? Math.round(n) : null
    }
  }

  // Reject zero / negative durations so junk never reaches duration_seconds.
  return seconds != null && seconds > 0 ? seconds : null
}

/**
 * Rough word count from an HTML fragment or page. Strips script/style blocks and
 * tags, decodes a few common entities, then counts whitespace-separated tokens.
 * Returns null when there are no words. Accurate for clean content:encoded bodies;
 * a ballpark for full article pages (nav/footer inflate it slightly).
 */
export function wordCountFromHtml(html: string | null | undefined): number | null {
  if (!html) return null
  const text = stripTags(html)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&[a-z]+;/gi, ' ')
    .trim()
  if (!text) return null
  const words = text.split(/\s+/).filter(Boolean)
  return words.length > 0 ? words.length : null
}

/** Scrape an og:image (or twitter:image fallback) out of HTML. Pure, no network. */
export function ogImageFromHtml(html: string | null | undefined): string | null {
  if (!html) return null
  let twitter: string | null = null
  for (const tag of findTags(html, 'meta')) {
    const key = (getAttribute(tag, 'property') ?? getAttribute(tag, 'name'))?.toLowerCase()
    if (key !== 'og:image' && key !== 'og:image:url' && key !== 'twitter:image') continue
    // Only accept absolute http(s) URLs (og:image is spec'd absolute); a relative
    // path would otherwise resolve against the app origin when rendered (#167 review).
    const content = absoluteHttpUrl(getAttribute(tag, 'content'))
    if (!content) continue
    if (key === 'og:image' || key === 'og:image:url') return content
    twitter = twitter ?? content
  }
  return twitter
}

/** Synchronous, no-network enrichment from the cheap RSS fields. */
export function enrichFromRssItem(item: RssItem): RssEnrichment {
  const imageUrl = deriveYouTubeThumbnail(item.link) ?? imageFromRssItem(item)
  const body = (item['content:encoded'] as string | undefined) ?? item.content
  const wordCount = wordCountFromHtml(body)
  const itunes = item.itunes as { duration?: unknown } | undefined
  const durationSeconds = parseItunesDuration(itunes?.duration)
  return { imageUrl, wordCount, durationSeconds }
}

/**
 * Guarded single fetch of an HTML document. http(s) only, timeout-bounded, body
 * capped, and never throws — returns null on any failure (bad URL, non-2xx,
 * timeout, network error).
 */
async function fetchHtml(url: string): Promise<string | null> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null

  try {
    // The link is feed-controlled: safeFetch blocks private/loopback/metadata
    // addresses (#281 F5), and maxRedirects:0 means a 30x is a failure rather
    // than a hop to somewhere else.
    const res = await safeFetch(url, {
      timeoutMs: FETCH_TIMEOUT_MS,
      maxRedirects: 0,
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
    })
    if (!res.ok) return null
    return await readTextCapped(res, MAX_HTML_BYTES)
  } catch {
    return null
  }
}

/** Best-effort og:image scrape. Returns null on any failure. */
export async function fetchOgImage(url: string): Promise<string | null> {
  const html = await fetchHtml(url)
  return html ? ogImageFromHtml(html) : null
}

/**
 * Asynchronous fallback enrichment: fetch the article HTML once and scrape both
 * og:image and a rough word count. Never throws.
 */
export async function enrichFromUrl(url: string): Promise<UrlEnrichment> {
  const html = await fetchHtml(url)
  if (!html) return { imageUrl: null, wordCount: null }
  return { imageUrl: ogImageFromHtml(html), wordCount: wordCountFromHtml(html) }
}
