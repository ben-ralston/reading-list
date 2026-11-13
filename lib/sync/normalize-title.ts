/**
 * Title normalization and fuzzy matching for deduplication
 *
 * Handles common variations between platforms:
 * - Curly quotes vs straight quotes
 * - Em/en dashes vs hyphens
 * - Trailing author attributions ("by Author", "- Author")
 * - Surrounding quote pairs
 * - Unicode whitespace and zero-width characters
 */

/**
 * Normalize a title for comparison purposes
 *
 * @param title - Raw title string
 * @param author - Optional author name to strip trailing attributions
 * @returns Normalized lowercase title
 */
export function normalizeTitle(title: string | null | undefined, author?: string): string {
  if (!title || title.trim() === '') return ''

  let result = title

  // Strip trailing author attribution first (before quotes, since quotes
  // may only wrap the title portion, e.g. "Good Article" by Author)
  if (author && author.trim()) {
    result = stripTrailingAuthor(result, author.trim())
  }

  // Strip "Title" by Attribution pattern (common in podcast/blog platforms
  // where titles are formatted as: "Article Title" by Individual Author)
  result = stripQuotedAttribution(result)

  // Strip surrounding quote pairs (outermost only)
  result = stripSurroundingQuotes(result)

  // Unicode punctuation normalization (single pass)
  result = result
    // Curly single quotes → straight
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    // Curly double quotes → straight
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    // Em dash, en dash → hyphen
    .replace(/[\u2013\u2014]/g, '-')
    // Ellipsis → three dots
    .replace(/\u2026/g, '...')
    // Non-breaking space, thin space, hair space, etc. → regular space
    .replace(/[\u00A0\u2009\u200A\u202F\u205F\u3000]/g, ' ')
    // Zero-width characters → remove
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')

  // Collapse whitespace
  result = result.replace(/\s+/g, ' ')

  // Trim and lowercase
  return result.trim().toLowerCase()
}

/**
 * Reduce an already-normalized title to its "base" form for cross-source book
 * matching: drop a ": subtitle" tail and a trailing " (Series, #N)" parenthetical.
 *
 * Audible reports base titles ("Manufacturing Consent") while Goodreads stores
 * the full title with a subtitle or series suffix ("Manufacturing Consent: The
 * Political Economy of the Mass Media"). Those diverge by far more than the
 * fuzzy-match edit budget, so without this they create duplicate books (#42).
 *
 * Expects the output of {@link normalizeTitle} (already lowercased / unicode-
 * normalized). Returns '' when nothing meaningful remains.
 *
 * @param normalizedTitle - A normalized title (see normalizeTitle)
 * @returns The base title, or '' if empty after stripping
 */
export function baseTitle(normalizedTitle: string): string {
  if (!normalizedTitle) return ''

  let result = normalizedTitle

  // Drop a subtitle: everything from the first colon onward. Guard against a
  // leading colon (index 0) so a title that merely starts with ':' isn't wiped.
  const colonIndex = result.indexOf(':')
  if (colonIndex > 0) {
    result = result.slice(0, colonIndex)
  }

  // Drop a single trailing parenthetical (series/volume), e.g. "(children of
  // time, #1)". Non-greedy on inner parens so only the outermost trailing group
  // is removed.
  result = result.replace(/\s*\([^()]*\)\s*$/, '')

  return result.trim()
}

/**
 * Strip matching surrounding quote pairs from a string.
 * Only removes the outermost pair if it wraps the entire string.
 */
function stripSurroundingQuotes(s: string): string {
  const trimmed = s.trim()
  if (trimmed.length < 2) return trimmed

  const pairs: [string, string][] = [
    ['"', '"'],
    ["'", "'"],
    ['\u201C', '\u201D'], // " "
    ['\u2018', '\u2019'], // ' '
  ]

  for (const [open, close] of pairs) {
    if (trimmed.startsWith(open) && trimmed.endsWith(close)) {
      return trimmed.slice(open.length, -close.length).trim()
    }
  }

  return trimmed
}

/**
 * Strip "Title" by Attribution pattern from a title.
 * Handles the case where a platform formats the title as:
 *   "Article Title" by Individual Author Name
 * The quotes wrap the real title, and the attribution follows.
 * Only activates when the title starts with a quote, has a matching
 * closing quote, and the remainder starts with ` by <name>`.
 */
function stripQuotedAttribution(s: string): string {
  const trimmed = s.trim()
  if (trimmed.length < 5) return trimmed

  const quotePairs: [string, string][] = [
    ['"', '"'],
    ["'", "'"],
    ['\u201C', '\u201D'],
    ['\u2018', '\u2019'],
  ]

  for (const [open, close] of quotePairs) {
    if (!trimmed.startsWith(open)) continue

    // Find the last occurrence of the closing quote
    const closeIndex = trimmed.lastIndexOf(close)
    if (closeIndex <= open.length) continue

    // Check if text after closing quote matches ` by <name>`
    const afterQuote = trimmed.slice(closeIndex + close.length).trim()
    if (/^by\s+\S/i.test(afterQuote)) {
      return trimmed.slice(open.length, closeIndex).trim()
    }
  }

  return trimmed
}

/**
 * Strip trailing author attribution patterns from a title.
 * Handles " by Author" and " - Author" (case-insensitive).
 * Uses various dash characters (hyphen, en dash, em dash).
 *
 * Plain string scans, not an unanchored /\s+by\s+…\s*$/ regex: titles are
 * feed-controlled and that regex is O(n²) on long whitespace runs (#281, F3).
 */
function stripTrailingAuthor(title: string, author: string): string {
  const trimmed = title.trimEnd()
  if (trimmed.length < author.length) return title
  const tail = trimmed.slice(trimmed.length - author.length)
  if (tail.toLowerCase() !== author.toLowerCase()) return title
  const before = trimmed.slice(0, trimmed.length - author.length)

  // " by Author": whitespace, "by", whitespace, author
  const beforeAuthor = before.trimEnd()
  if (beforeAuthor.length < before.length && beforeAuthor.toLowerCase().endsWith('by')) {
    const beforeBy = beforeAuthor.slice(0, -2)
    if (beforeBy.length > beforeBy.trimEnd().length) {
      return beforeBy.trim()
    }
  }

  // " - Author", " – Author", " — Author" (whitespace optional on both sides)
  if (/[-\u2013\u2014]$/.test(beforeAuthor)) {
    return beforeAuthor.slice(0, -1).trim()
  }

  return title
}

/**
 * Compute Levenshtein distance between two strings.
 * Standard single-row DP implementation.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  // Use shorter string as the "column" for space efficiency
  if (a.length > b.length) [a, b] = [b, a]

  const row = Array.from({ length: a.length + 1 }, (_, i) => i)

  for (let j = 1; j <= b.length; j++) {
    let prev = row[0]
    row[0] = j

    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const temp = row[i]
      row[i] = Math.min(
        row[i] + 1, // deletion
        row[i - 1] + 1, // insertion
        prev + cost // substitution
      )
      prev = temp
    }
  }

  return row[a.length]
}

/**
 * Compute a fuzzy match score for two already-normalized titles.
 * Returns a similarity score (0–1) if the titles pass all guards,
 * or null if they don't qualify as a fuzzy match.
 *
 * Guards:
 * - Both titles must be >= 10 chars
 * - First and last alphanumeric tokens must match (boundary check)
 * - Levenshtein distance <= 3
 * - Relative distance < 10% of the longer title
 * - Differences must not be only in digit characters
 */
export function fuzzyTitleScore(a: string, b: string): number | null {
  if (a === b) return 1
  if (a.length < 10 || b.length < 10) return null

  if (!boundaryTokensMatch(a, b)) return null

  const distance = levenshteinDistance(a, b)
  if (distance > 3) return null

  const maxLen = Math.max(a.length, b.length)
  if (distance / maxLen >= 0.1) return null

  if (differenceIsOnlyDigits(a, b)) return null

  return 1 - distance / maxLen
}

/**
 * Check if two already-normalized titles are a fuzzy match.
 */
export function titlesAreFuzzyMatch(a: string, b: string): boolean {
  return fuzzyTitleScore(a, b) !== null
}

/**
 * Check if two same-length strings differ only in digit characters.
 * For different-length strings, returns false (can't do positional comparison).
 */
function differenceIsOnlyDigits(a: string, b: string): boolean {
  if (a.length !== b.length) return false

  let hasDiff = false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      // At least one side must be a digit for this to be a "digit-only" diff
      if (!/\d/.test(a[i]) && !/\d/.test(b[i])) return false
      hasDiff = true
    }
  }
  return hasDiff
}

/**
 * Extract the first or last alphanumeric token from a string.
 */
function getBoundaryToken(s: string, fromStart: boolean): string {
  const tokens = s.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return ''
  const token = fromStart ? tokens[0] : tokens[tokens.length - 1]
  return token.replace(/[^a-z0-9]/g, '')
}

/**
 * Check that the first and last alphanumeric tokens of two strings match.
 * Cheap pre-filter before expensive Levenshtein computation.
 */
function boundaryTokensMatch(a: string, b: string): boolean {
  const firstA = getBoundaryToken(a, true)
  const firstB = getBoundaryToken(b, true)
  const lastA = getBoundaryToken(a, false)
  const lastB = getBoundaryToken(b, false)
  if (!firstA || !firstB || !lastA || !lastB) return false
  return firstA === firstB && lastA === lastB
}
