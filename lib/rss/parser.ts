/**
 * RSS feed parsing and metadata extraction.
 *
 * Three parsing strategies (by feed_type):
 * - substack: title, author from feed record, link (cleaned), publishedOn from pubDate
 * - lesswrong: title as-is, fixed author, link extracted from description HTML
 * - generic: title, author from <dc:creator>/feed record, link (cleaned)
 */

import type { FeedType } from './detect'
import type { SyncItem } from '@/lib/sync/matching'
import { enrichFromRssItem } from './enrich'

/** Minimal feed shape the parser needs (a structural subset of RssFeed). */
export interface ParserFeed {
  feedType: FeedType
  authorName: string | null
  platform: string
}

/** Parsed RSS item from rss-parser */
export interface RssItem {
  title?: string
  link?: string
  pubDate?: string
  isoDate?: string
  content?: string
  contentSnippet?: string
  [key: string]: unknown
}

/**
 * Strip UTM and other tracking parameters from a URL.
 */
export function stripTrackingParams(url: string): string {
  if (!url) return ''

  try {
    const parsed = new URL(url)
    const keysToRemove: string[] = []

    for (const key of parsed.searchParams.keys()) {
      if (key.startsWith('utm_')) {
        keysToRemove.push(key)
      }
    }

    for (const key of keysToRemove) {
      parsed.searchParams.delete(key)
    }

    // Remove trailing '?' if no params remain
    let result = parsed.toString()
    if (result.endsWith('?')) {
      result = result.slice(0, -1)
    }
    return result
  } catch {
    return url
  }
}

/**
 * Extract a LessWrong article URL from Buzzsprout episode description HTML.
 * Tries two passes so URLs that appear outside of an href attribute (as
 * anchor text or inline plain text) are still recoverable.
 */
export function extractLessWrongUrl(description: string): string | null {
  if (!description) return null

  // First pass: href-prefixed URL (the preferred serialization).
  const hrefMatch = description.match(/href=['"]?(https:\/\/(?:www\.)?lesswrong\.com\/posts\/[^'"?\s]+)/i)
  if (hrefMatch) return stripTrackingParams(hrefMatch[1])

  // Second pass: bare URL (anchor text, footnote, <p>, etc.).
  const bareMatch = description.match(/(https:\/\/(?:www\.)?lesswrong\.com\/posts\/[^\s'"<>]+)/i)
  if (bareMatch) return stripTrackingParams(bareMatch[1])

  return null
}

/**
 * Parse a date string into YYYY-MM-DD format.
 */
function formatDate(isoDate?: string, pubDate?: string): string | undefined {
  const dateStr = isoDate || pubDate
  if (!dateStr) return undefined

  try {
    const date = new Date(dateStr)
    if (isNaN(date.getTime())) return undefined
    return date.toISOString().split('T')[0]
  } catch {
    return undefined
  }
}

/**
 * Bounds on attacker-controlled feed fields (#281). Titles/authors feed regex-
 * heavy matching and scoring, and links are re-parsed on every queue render, so
 * nothing unbounded may get past ingest. Real values are far below these.
 */
export const MAX_TITLE_LENGTH = 500
export const MAX_AUTHOR_LENGTH = 200
export const MAX_LINK_LENGTH = 2048

// rss-parser types these as strings, but structured XML (e.g. a dc:creator
// with child elements) arrives as an object — only bound actual strings.
const bounded = (value: unknown, max: number) =>
  typeof value === 'string' ? value.slice(0, max) : value

function boundFields<T extends { title: string; author: string; link: string }>(item: T): T | null {
  if (typeof item.link === 'string' && item.link.length > MAX_LINK_LENGTH) return null
  return {
    ...item,
    title: bounded(item.title, MAX_TITLE_LENGTH),
    author: bounded(item.author, MAX_AUTHOR_LENGTH),
  }
}

export function parseRssItems(
  items: RssItem[],
  config: ParserFeed
): Omit<SyncItem, 'manuallyRequested'>[] {
  return items
    .filter((item) => item.title && item.title.trim() !== '')
    .map((item) => {
      const publishedOn = formatDate(item.isoDate, item.pubDate)
      // Cheap, no-network feed-card enrichment (#167): thumbnail from enclosure/
      // itunes/media/YouTube, word count from content:encoded, duration from
      // itunes:duration. The og:image fallback (a network fetch) runs later, in
      // the sync route, only for items that are actually created.
      const enrichment = enrichFromRssItem(item)

      if (config.feedType === 'lesswrong') {
        const lesswrongUrl = extractLessWrongUrl(item.content || '')
        const link = lesswrongUrl || stripTrackingParams(item.link || '')
        return {
          title: item.title!,
          author: config.authorName ?? 'Unknown',
          platform: config.platform,
          link,
          ...(publishedOn && { publishedOn }),
          ...enrichment,
        }
      }

      if (config.feedType === 'generic') {
        // rss-parser surfaces the dc:creator element as both item.creator and item['dc:creator'].
        const creator =
          (item.creator as string | undefined) ||
          (item['dc:creator'] as string | undefined) ||
          config.authorName ||
          'Unknown'
        return {
          title: item.title!,
          author: creator,
          platform: config.platform,
          link: stripTrackingParams(item.link || ''),
          ...(publishedOn && { publishedOn }),
          ...enrichment,
        }
      }

      // substack
      return {
        title: item.title!,
        author: config.authorName ?? 'Unknown',
        platform: config.platform,
        link: stripTrackingParams(item.link || ''),
        ...(publishedOn && { publishedOn }),
        ...enrichment,
      }
    })
    .map(boundFields)
    .filter((item): item is NonNullable<typeof item> => item !== null)
}
