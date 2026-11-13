/**
 * Book cover resolver (#168). Resolves a cover image URL (and ISBN-13 when the
 * source exposes one) from a book's title + author, since the imported library
 * has neither covers nor ISBNs stored. Open Library Search is tried first
 * (no key, returns a stable cover id + ISBNs); Google Books is the fallback.
 *
 * Resilient by contract, mirroring lib/rss/enrich.ts: requests are https-only,
 * bounded by a timeout, and NEVER throw — every failure path returns null so a
 * single bad lookup can't break a batch. Used by the book-covers backfill and
 * safe to call from a server route.
 */
// Open Library's search.json is genuinely slow (p99 can exceed 8s), and this
// resolver only runs from the one-time book-cover backfill — not a latency-
// sensitive request path — so a generous timeout maximizes the hit rate.
import { normalizeTitle, baseTitle } from '@/lib/sync/normalize-title'

const FETCH_TIMEOUT_MS = 15000
const USER_AGENT =
  'Mozilla/5.0 (compatible; reading-list/1.0)'

/**
 * Reduce a Goodreads title to its base work title for cover search: drop the
 * ": subtitle" tail and the "(Series, #N)" suffix that otherwise make an exact
 * title search miss (e.g. "Children of Time (Children of Time, #1)" finds 0).
 *
 * Two cover-search-specific cleanups are layered on top of the shared baseTitle
 * (kept out of baseTitle itself, which feeds dedup #42): drop "[...]" edition
 * tags ("[Blackstone Audio]", "[Unabridged]") and a ", or ..." alternative-title
 * tail ("Blood Meridian, or the Evening Redness in the West" → "blood meridian").
 * Falls back to the raw title if normalization leaves nothing.
 */
function searchTitle(title: string, author: string): string {
  const base = baseTitle(normalizeTitle(title, author)) || title
  const cleaned = base
    .replace(/\s*\[[^\]]*\]/g, '')
    .replace(/,\s+or\s+.*$/i, '')
    .trim()
  return cleaned || title
}

export interface BookCoverResult {
  imageUrl: string
  isbn13: string | null
  source: 'openlibrary' | 'google'
}

/** Guarded JSON GET: https-only, timeout-bounded, never throws (null on failure). */
async function fetchJson(url: string): Promise<unknown | null> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** First entry in `isbns` that looks like an ISBN-13 (13 digits), else null. */
function firstIsbn13(isbns: unknown): string | null {
  if (!Array.isArray(isbns)) return null
  for (const v of isbns) {
    if (typeof v === 'string' && /^\d{13}$/.test(v)) return v
  }
  return null
}

/** One Open Library search.json call → first result that carries a cover. */
async function olSearch(params: string): Promise<BookCoverResult | null> {
  const url = `https://openlibrary.org/search.json?${params}&fields=cover_i,isbn&limit=5`
  const data = (await fetchJson(url)) as { docs?: Array<{ cover_i?: number; isbn?: string[] }> } | null
  // Scan the top results for the first edition that actually has a cover — the
  // best title match doesn't always carry one.
  const doc = (data?.docs ?? []).find((d) => typeof d.cover_i === 'number')
  if (!doc || typeof doc.cover_i !== 'number') return null
  return {
    imageUrl: `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`,
    isbn13: firstIsbn13(doc.isbn),
    source: 'openlibrary',
  }
}

/**
 * Open Library Search → cover id + ISBN. Returns null when no usable cover is
 * found. `cover_i` maps to a stable covers.openlibrary.org URL.
 *
 * Tries a strict fielded `title=&author=` search first (high precision), then
 * falls back to a general `q=` full-text search (title + author together) for
 * noisy titles the fielded search can't match — this recovers many heavily
 * subtitled / anthology titles (#168).
 */
export async function fromOpenLibrary(title: string, author: string): Promise<BookCoverResult | null> {
  const query = searchTitle(title, author)
  const strict = await olSearch(
    `title=${encodeURIComponent(query)}&author=${encodeURIComponent(author)}`,
  )
  if (strict) return strict
  return olSearch(`q=${encodeURIComponent(`${query} ${author}`)}`)
}

/** Strip Google's curled-page effect and force https so covers load on an https site. */
function normalizeGoogleThumbnail(raw: string): string {
  return raw.replace(/^http:\/\//, 'https://').replace(/&edge=curl/g, '')
}

/**
 * Google Books → thumbnail + ISBN-13. Returns null when the top result has no
 * image. The thumbnail is normalized to https with the page-curl effect removed.
 */
export async function fromGoogleBooks(title: string, author: string): Promise<BookCoverResult | null> {
  const url =
    `https://www.googleapis.com/books/v1/volumes?q=` +
    `${encodeURIComponent(`intitle:${searchTitle(title, author)} inauthor:${author}`)}&maxResults=1&country=US`
  const data = (await fetchJson(url)) as {
    items?: Array<{
      volumeInfo?: {
        imageLinks?: { thumbnail?: string; smallThumbnail?: string }
        industryIdentifiers?: Array<{ type?: string; identifier?: string }>
      }
    }>
  } | null
  const info = data?.items?.[0]?.volumeInfo
  const thumb = info?.imageLinks?.thumbnail ?? info?.imageLinks?.smallThumbnail
  if (!thumb) return null
  const isbn13 = info?.industryIdentifiers?.find((i) => i.type === 'ISBN_13')?.identifier ?? null
  return {
    imageUrl: normalizeGoogleThumbnail(thumb),
    isbn13: isbn13 && /^\d{13}$/.test(isbn13) ? isbn13 : null,
    source: 'google',
  }
}

/**
 * Resolve a book cover from title + author: Open Library first, Google Books as
 * fallback, null when neither yields a cover. Never throws.
 */
export async function resolveBookCover(title: string, author: string): Promise<BookCoverResult | null> {
  return (await fromOpenLibrary(title, author)) ?? (await fromGoogleBooks(title, author))
}
