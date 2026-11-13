/**
 * Book metadata parser for the agentic "Add book" flow (#186).
 *
 * Mirrors lib/entry-parser.ts but returns a richer, book-specific shape. Both
 * input types resolve through a single agentic Claude call:
 * - Free text (title / "title author" / ISBN): Claude + web_search finds the book.
 * - A pasted book URL (Goodreads/Amazon/Open Library): Claude + web_search +
 *   web_fetch reads the page and fills the same fields.
 *
 * The agent ALWAYS attempts a canonical Goodreads link, a cover image, and an
 * ISBN-13 — not just when the user supplied them. Creation is NOT done here; the
 * caller (the AddBookDialog → /api/add-entry) owns dedup + persistence. This
 * module only looks up metadata and reports a confidence level.
 *
 * Never throws on a lookup failure: a missing API key, a network error, or an
 * unparseable response degrades to a low-confidence stub so the UI can fall back
 * to the editable manual form rather than showing the user nothing.
 */

import Anthropic from '@anthropic-ai/sdk'
import { isUrl, isDegenerateTitle, normalizeDate } from './entry-parser'

export interface BookMetadata {
  title: string
  author: string
  subtitle?: string
  series?: string
  isbn13?: string
  /** Canonical Goodreads book-page URL (/book/show/<id>), or undefined. */
  goodreadsUrl?: string
  /** Cover image URL — maps to content_items.image_url on save. */
  coverImageUrl?: string
  publishedOn?: string // YYYY-MM-DD
  confidence: 'high' | 'low'
}

const MODEL = 'claude-sonnet-4-5-20250929'
const MAX_TOKENS = 800

// Goodreads canonical book pages live under /book/show/. A search URL (or any
// other path) is NOT a stable identifier — storing it would seed the kind of
// junk-dedup-magnet row #176 fought, so we drop anything that isn't /book/show/.
const GOODREADS_BOOK_URL = /goodreads\.com\/book\/show\//i

// A recognized book-*source* page — the only kind of URL input strong enough to
// bias confidence to 'high' (which auto-saves with no review). isUrl() alone is
// just an http(s) prefix, so a pasted blog post or an Amazon *search* page would
// otherwise force high and drop a junk kind:'book' row into the library (RLV-002).
// Match only specific book pages, never listing/search pages:
//   - Goodreads: /book/show/<id>
//   - Amazon:    /dp/<ASIN> or /gp/product/<ASIN> (excludes /s?k= search). NOTE:
//     /dp/ is Amazon's canonical path for ANY product, not just books, so a
//     non-book Amazon product page can still bias to high — an accepted, much
//     narrower residual than the original any-URL bug, in a book-add context.
//   - Open Library: /books/<id> or /works/<id>
const BOOK_SOURCE_URL = new RegExp(
  [
    'goodreads\\.com\\/book\\/show\\/',
    'amazon\\.[a-z.]{2,}\\/(?:[^?#]*\\/)?(?:dp|gp\\/product)\\/[A-Z0-9]{10}',
    'openlibrary\\.org\\/(?:books|works)\\/',
  ].join('|'),
  'i',
)

const SYSTEM_PROMPT = `You are a book metadata researcher. Given a book title, an "title author" string, an ISBN, or a book URL, identify the specific book and return its metadata.

Use web_search (and web_fetch when a URL is given) to find authoritative details. ALWAYS attempt to find:
- The canonical Goodreads book-page URL in the exact form https://www.goodreads.com/book/show/<id>... . If you cannot find the real book page, omit it — NEVER return a Goodreads search URL.
- A cover image URL.
- The ISBN-13 (13 digits, as a string — preserve leading zeros).

Return ONLY a JSON object (no prose) with these fields:
- title (string)
- author (string — the primary author)
- subtitle (string, or "" if none)
- series (string with the series name and number if applicable, or "" if none)
- isbn13 (string of 13 digits, or "")
- goodreadsUrl (string canonical /book/show/ URL, or "")
- coverImageUrl (string, or "")
- publishedOn (string YYYY-MM-DD, or "")
- confidence ("high" only if you are confident you identified the exact book with a title and author; otherwise "low")`

/**
 * Look up book metadata from free text or a book URL. Never throws — a failure
 * returns a low-confidence stub.
 */
export async function parseBook(input: string): Promise<BookMetadata> {
  const trimmed = input.trim()
  const inputIsUrl = isUrl(trimmed)
  // Only a recognized book-source page biases confidence to high (see below).
  const inputIsBookUrl = BOOK_SOURCE_URL.test(trimmed)

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.warn('[Book Parser] ANTHROPIC_API_KEY not configured; returning low-confidence stub')
    return fallback(trimmed, inputIsUrl)
  }

  try {
    const client = new Anthropic({ apiKey })

    // web_fetch is only useful when the user pasted a URL for the model to read.
    const tools: Anthropic.Tool[] = [
      { type: 'web_search_20250305', name: 'web_search', max_uses: 3 } as unknown as Anthropic.Tool,
    ]
    if (inputIsUrl) {
      tools.push({ type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 2 } as unknown as Anthropic.Tool)
    }

    const userContent = inputIsUrl
      ? `Identify the book at this URL and return its metadata: ${trimmed}`
      : `Find this book and return its metadata: "${trimmed}"`

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools,
      messages: [{ role: 'user', content: userContent }],
    })

    const textBlocks = response.content.filter(
      (block): block is Anthropic.TextBlock => block.type === 'text',
    )
    const text = textBlocks.map((b) => b.text).join('')

    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      console.warn('[Book Parser] No JSON in Claude response; returning low-confidence stub')
      return fallback(trimmed, inputIsUrl)
    }

    const parsed = JSON.parse(jsonMatch[0]) as Partial<BookMetadata>
    return normalizeMetadata(parsed, inputIsBookUrl)
  } catch (e) {
    console.warn('[Book Parser] Lookup failed, returning low-confidence stub:', e)
    return fallback(trimmed, inputIsUrl)
  }
}

/**
 * Turn the raw LLM JSON into a validated BookMetadata. Applies the
 * server-authoritative confidence rule and the Goodreads junk-URL guard — the
 * model's self-reported confidence is a starting point, not the last word.
 */
function normalizeMetadata(parsed: Partial<BookMetadata>, inputIsBookUrl: boolean): BookMetadata {
  const title = (parsed.title || '').trim()
  const author = (parsed.author || '').trim()

  const goodreadsUrl =
    parsed.goodreadsUrl && GOODREADS_BOOK_URL.test(parsed.goodreadsUrl)
      ? parsed.goodreadsUrl.trim()
      : undefined

  // Start from the model's confidence; a pasted *book-source* page is strong
  // signal, so a recognized book URL biases to high. A generic URL (blog post,
  // search page) does NOT — it keeps the model's own confidence, so junk input
  // routes through the review form instead of auto-saving (RLV-002). Then force
  // low if the core fields are missing — never auto-save without title + author.
  let confidence: 'high' | 'low' = parsed.confidence === 'high' ? 'high' : 'low'
  if (inputIsBookUrl && title && author) confidence = 'high'
  if (!title || isDegenerateTitle(title) || !author) confidence = 'low'

  return {
    title,
    author,
    subtitle: emptyToUndefined(parsed.subtitle),
    series: emptyToUndefined(parsed.series),
    isbn13: emptyToUndefined(parsed.isbn13),
    goodreadsUrl,
    coverImageUrl: emptyToUndefined(parsed.coverImageUrl),
    publishedOn: normalizeBookDate(parsed.publishedOn),
    confidence,
  }
}

/**
 * Like normalizeDate, but books commonly carry only a publication year. Expand a
 * bare 4-digit year to Jan 1 (matching the Goodreads CSV importer convention)
 * rather than dropping it; defer everything else to the strict YYYY-MM-DD check.
 */
function normalizeBookDate(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (trimmed && /^\d{4}$/.test(trimmed)) return `${trimmed}-01-01`
  return normalizeDate(trimmed)
}

/**
 * Low-confidence stub for any failure path. Echoes free text back as a
 * best-effort title (so the manual form is pre-filled) but never echoes a raw
 * URL — that would be a junk title.
 */
function fallback(input: string, inputIsUrl: boolean): BookMetadata {
  return {
    title: inputIsUrl ? '' : input,
    author: '',
    confidence: 'low',
  }
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}
