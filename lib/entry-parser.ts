/**
 * Entry parser for manual content submissions.
 *
 * Handles two input types:
 * - URLs: Fetches page HTML, then uses Claude to extract metadata
 * - Plain text: Uses Claude API with web search to find the content
 *
 * Both paths use Claude for metadata extraction to ensure robust results.
 */

import Anthropic from '@anthropic-ai/sdk'
import { findTags, getAttribute, innerTextOf } from './html-scan'
import { readTextCapped, safeFetch } from './safe-fetch'

// Cap for buffered page HTML. Claude extraction only needs <head> + ~2KB of
// body, so truncating oversized pages is harmless (#206, was unbounded).
const MAX_HTML_BYTES = 1024 * 1024

export interface ParsedEntry {
  title: string
  author: string
  platform: string
  link: string
  publishedOn?: string // ISO date string (YYYY-MM-DD)
}

/**
 * Check if input looks like a URL.
 */
export function isUrl(input: string): boolean {
  return /^https?:\/\//i.test(input)
}

/**
 * Determine platform from a URL's domain.
 */
export function platformFromDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname.toLowerCase()

    if (hostname.includes('substack.com')) return 'Substack'
    if (hostname.includes('lesswrong.com')) return 'LessWrong'
    if (hostname.includes('spotify.com')) return 'Spotify'
    if (hostname.includes('audible.com')) return 'Audible'
    if (isYouTubeHostname(hostname)) return 'YouTube'

    return 'Website'
  } catch {
    return 'Website'
  }
}

/**
 * Check whether an extracted title is junk rather than real metadata.
 *
 * YouTube serves datacenter IPs a bot-walled page whose <title> is literally
 * "- YouTube" (no OG tags), so scraping yields a meaningless title. Letting
 * one through creates an invisible dedup magnet in the DB: every later failed
 * extraction matches it and reports "already in your list" (#176). Callers
 * should treat a degenerate title the same as a missing one.
 */
export function isDegenerateTitle(title: string): boolean {
  // Collapse separator punctuation, then see if anything meaningful remains.
  const stripped = title.replace(/[\s\-–—|:•·]+/g, ' ').trim().toLowerCase()
  return stripped === '' || stripped === 'youtube'
}

/**
 * Parse an entry from user input (URL or plain text).
 */
export async function parseEntry(input: string): Promise<ParsedEntry> {
  const trimmed = input.trim()

  if (isUrl(trimmed)) {
    return parseUrl(trimmed)
  }

  return parseTitle(trimmed)
}

/**
 * Check if a hostname is YouTube proper (exact or subdomain — substring
 * matching would also catch lookalikes like notyoutube.com).
 */
function isYouTubeHostname(hostname: string): boolean {
  return (
    hostname === 'youtube.com' ||
    hostname.endsWith('.youtube.com') ||
    hostname === 'youtu.be'
  )
}

/**
 * Check if a URL points at a YouTube video.
 */
function isYouTubeUrl(url: string): boolean {
  try {
    return isYouTubeHostname(new URL(url).hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * Fetch YouTube video metadata via the public oEmbed endpoint (no API key).
 *
 * YouTube bot-walls page fetches from datacenter IPs (no OG tags, "- YouTube"
 * <title>), so scraping the watch page from Vercel yields junk (#176). oEmbed
 * is the supported server-side path and returns the real title + channel name.
 * Returns null on any failure so the caller can fall back to page scraping.
 */
async function fetchYouTubeOEmbed(url: string): Promise<ParsedEntry | null> {
  try {
    const response = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
      { signal: AbortSignal.timeout(10_000) }
    )
    if (!response.ok) return null

    const data = (await response.json()) as { title?: string; author_name?: string }
    if (!data.title) return null

    return {
      title: data.title,
      author: data.author_name || '',
      platform: 'YouTube',
      link: url,
    }
  } catch (e) {
    console.warn('[Entry Parser] YouTube oEmbed failed, falling back to page scrape:', e)
    return null
  }
}

/**
 * Fetch a URL and use Claude to extract metadata from the page HTML.
 * Falls back to programmatic OG tag extraction if Claude API is unavailable.
 * YouTube URLs go through oEmbed first (see fetchYouTubeOEmbed).
 */
async function parseUrl(url: string): Promise<ParsedEntry> {
  if (isYouTubeUrl(url)) {
    const oembed = await fetchYouTubeOEmbed(url)
    if (oembed) return oembed
  }

  // SSRF-guarded (#206): user-supplied URL, reachable via the iOS Shortcut's
  // shared secret — must not fetch private/internal targets or buffer unbounded.
  const response = await safeFetch(url, {
    timeoutMs: 10_000,
    headers: { 'User-Agent': 'ReadingListBot/1.0' },
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch URL: ${response.status}`)
  }

  const html = await readTextCapped(response, MAX_HTML_BYTES)
  const platform = platformFromDomain(url)

  // Try Claude extraction first for best results
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (apiKey) {
    try {
      return await extractWithClaude(html, url, platform, apiKey)
    } catch (e) {
      console.warn('[Entry Parser] Claude extraction failed, falling back to programmatic:', e)
    }
  }

  // Programmatic fallback
  const title = extractMeta(html, 'og:title') || extractTitle(html) || url
  const author = extractMeta(html, 'author', 'name') ||
    extractMeta(html, 'og:site_name') ||
    ''

  return { title, author, platform, link: url }
}

/**
 * The <head> section + first 2000 chars of body, to stay within context limits.
 * Linear scans (lib/html-scan.ts), not /<head[^>]*>([\s\S]*?)<\/head>/: the page
 * is attacker-served and that regex is O(n²) on unclosed markup (#281, F11).
 */
export function htmlForClaude(html: string): string {
  const head = innerTextOf(html, 'head') ?? ''
  const body = innerTextOf(html, 'body', { allowUnclosed: true })
  const bodySnippet = body !== null ? body.slice(0, 2000) : html.slice(0, 3000)
  return `<head>${head}</head>\n<body>${bodySnippet}</body>`
}

/**
 * Use Claude to extract metadata from page HTML.
 * Truncates HTML to avoid exceeding context limits.
 */
async function extractWithClaude(
  html: string,
  url: string,
  platform: string,
  apiKey: string
): Promise<ParsedEntry> {
  const client = new Anthropic({ apiKey })

  const truncatedHtml = htmlForClaude(html)

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 500,
    system: `Extract metadata from this web page. Return ONLY a JSON object with these fields:
- title (string): the article/content title
- author (string): the author's name
- platform (string): "${platform}" unless you can determine a more specific one from "Substack", "LessWrong", "Spotify", "Audible", or "Website"
- publishedOn (string): publish date in YYYY-MM-DD format, or empty string if unknown

Be precise. Prefer the article author over the site name.`,
    messages: [{
      role: 'user',
      content: `URL: ${url}\n\nPage HTML:\n${truncatedHtml}`,
    }],
  })

  const textBlocks = response.content.filter(
    (block): block is Anthropic.TextBlock => block.type === 'text'
  )
  const text = textBlocks.map((b) => b.text).join('')

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    const parsed = JSON.parse(jsonMatch[0]) as Partial<ParsedEntry>
    return {
      title: parsed.title || url,
      author: parsed.author || '',
      platform: parsed.platform || platform,
      link: url,
      publishedOn: normalizeDate(parsed.publishedOn),
    }
  }

  throw new Error('No JSON in Claude response')
}

/**
 * Use Claude API to search for content by title and extract metadata.
 */
async function parseTitle(title: string): Promise<ParsedEntry> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured')
  }

  const client = new Anthropic({ apiKey })

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 500,
    system: `You are a research assistant. Find the URL, author, publish date, and platform for the given content title. Return ONLY a JSON object with these fields: title (string), author (string), platform (string: "Substack", "LessWrong", "Spotify", "Audible", or "Website"), link (string: full URL), publishedOn (string: YYYY-MM-DD format, or empty string if unknown). If you cannot find the content, return the best guess with the title as given and empty strings for unknown fields.`,
    tools: [{
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 3,
    }],
    messages: [{ role: 'user', content: `Find this content: "${title}"` }],
  })

  // Extract the text response (after any tool use)
  const textBlocks = response.content.filter(
    (block): block is Anthropic.TextBlock => block.type === 'text'
  )
  const text = textBlocks.map((b) => b.text).join('')

  try {
    // Try to parse JSON from the response
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Partial<ParsedEntry>
      return {
        title: parsed.title || title,
        author: parsed.author || '',
        platform: parsed.platform || 'Website',
        link: parsed.link || '',
        publishedOn: normalizeDate(parsed.publishedOn),
      }
    }
  } catch {
    // JSON parsing failed — fall back
  }

  // Fallback: return the title as-is
  return { title, author: '', platform: 'Website', link: '' }
}

/**
 * Validate and normalize a date string to YYYY-MM-DD format.
 * Returns undefined if the date is invalid or incomplete.
 */
export function normalizeDate(date: string | undefined): string | undefined {
  if (!date) return undefined
  // Must be YYYY-MM-DD format
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date
  // Try parsing partial dates like "2023-07" — reject them
  return undefined
}

/**
 * Extract content from an Open Graph or meta tag. Linear scan (#281, F11).
 */
function extractMeta(html: string, property: string, attr: string = 'property'): string | null {
  for (const tag of findTags(html, 'meta')) {
    if (getAttribute(tag, attr)?.toLowerCase() !== property.toLowerCase()) continue
    const content = getAttribute(tag, 'content')
    if (content !== null) return content
  }
  return null
}

/**
 * Extract text from the <title> tag. Linear scan (#281, F11).
 */
function extractTitle(html: string): string | null {
  const inner = innerTextOf(html, 'title')
  if (!inner || inner.includes('<')) return null
  return inner.trim() || null
}
