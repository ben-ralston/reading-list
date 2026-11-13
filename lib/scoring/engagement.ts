/**
 * Two-tier engagement scoring for content prioritization
 *
 * Uses the best available signal to score new content:
 * 1. Series-level score (e.g., "AI #" posts by Zvi) when enough data exists
 * 2. Author-level score as fallback
 * 3. Neutral 0.0 for unknown authors
 */

import { SupabaseClient } from '@supabase/supabase-js'

/**
 * Extract a series key from a content title for grouping.
 *
 * Identifies recurring series patterns like "AI #140: ..." or "Open Thread 402".
 * Returns null if no meaningful series pattern is detected.
 */
/**
 * Drop the maximal trailing run of digits, whitespace and '/' if it contains a
 * digit. Same result as /[\s/]*\d[\d\s/]*$/ but a single right-to-left scan:
 * titles are feed-controlled and that regex is O(n²) (#281, F17).
 */
function stripTrailingNumberRun(s: string): string {
  let i = s.length
  let sawDigit = false
  while (i > 0) {
    const ch = s[i - 1]
    if (ch >= '0' && ch <= '9') sawDigit = true
    else if (ch !== '/' && !/\s/.test(ch)) break
    i--
  }
  return sawDigit ? s.slice(0, i) : s
}

export function extractSeriesKey(title: string): string | null {
  if (!title || title.trim() === '') return null

  const trimmed = title.trim()

  // Strategy 1: Split on `:` and strip trailing numbers from the first segment
  const colonIndex = trimmed.indexOf(':')
  let candidate: string

  if (colonIndex > 0) {
    candidate = trimmed.substring(0, colonIndex).trim()
  } else {
    candidate = trimmed
  }

  // Strip trailing digits, whitespace, and `/` — but preserve `#` as part of the prefix
  // e.g., "AI #140" → "AI #", "Open Thread 402" → "Open Thread", "Monthly Roundup #35" → "Monthly Roundup #"
  const stripped = stripTrailingNumberRun(candidate).trim()

  if (stripped.length >= 2 && stripped !== trimmed) {
    return stripped
  }

  // Strategy 2: If stripping didn't produce a useful key, try first 2 words
  // Only useful if the title has 3+ words (otherwise it's likely a standalone title)
  const words = trimmed.split(/\s+/)
  if (words.length >= 3) {
    const twoWords = words.slice(0, 2).join(' ')
    if (twoWords.length >= 2) {
      return twoWords
    }
  }

  return null
}

/**
 * Get author aliases from the database for a given author name.
 * Returns lowercase aliases array, or [lowercase author] if no aliases found.
 */
export async function getAuthorAliases(
  author: string,
  supabase: SupabaseClient
): Promise<string[]> {
  const { data, error } = await supabase.rpc('get_author_aliases', {
    p_author: author,
  })

  if (error) {
    console.error('[Scoring] Error fetching author aliases:', error)
    return [author.toLowerCase().trim()]
  }

  const aliases = data as string[]
  if (!aliases || aliases.length === 0) {
    return [author.toLowerCase().trim()]
  }

  return aliases
}

interface ContentRow {
  title: string
  status: string
  author: string
}

/**
 * Fetch all items for a canonical author group.
 * Single DB round-trip, ~100 items max per author.
 */
async function fetchAuthorItems(
  aliases: string[],
  supabase: SupabaseClient
): Promise<ContentRow[]> {
  // Query each alias individually to avoid PostgREST .or() filter parsing issues
  // with special characters in author names (commas, quotes, pipes)
  const results = await Promise.all(
    aliases.map(alias =>
      supabase
        .from('content_items')
        .select('title, status, author')
        .ilike('author', alias)
    )
  )

  // Merge and deduplicate results across aliases
  const seen = new Set<string>()
  const items: ContentRow[] = []
  for (const { data, error } of results) {
    if (error) {
      console.error('[Scoring] Error fetching author items:', error)
      continue
    }
    for (const item of (data || []) as ContentRow[]) {
      const key = `${item.title}|${item.author}`
      if (!seen.has(key)) {
        seen.add(key)
        items.push(item)
      }
    }
  }

  return items
}

/**
 * Get series-level engagement score if enough data exists.
 *
 * Fetches all items for the canonical author, groups by series key,
 * and returns the score for the matching series if it has >= 3 items
 * with >= 2 decided (completed + skipped).
 */
export async function getSeriesScore(
  seriesKey: string,
  author: string,
  supabase: SupabaseClient
): Promise<number | null> {
  const aliases = await getAuthorAliases(author, supabase)
  const authorItems = await fetchAuthorItems(aliases, supabase)

  // Filter to items matching this series key
  const seriesItems = authorItems.filter(item => {
    const key = extractSeriesKey(item.title)
    return key !== null && key === seriesKey
  })

  if (seriesItems.length < 3) return null

  const completed = seriesItems.filter(item => item.status === 'Completed').length
  const skipped = seriesItems.filter(item => item.status === 'Skip').length
  const decided = completed + skipped

  if (decided < 2) return null

  return (completed - skipped) / seriesItems.length
}

/**
 * Get author-level engagement score from the database view.
 */
export async function getAuthorScore(
  author: string,
  supabase: SupabaseClient
): Promise<number | null> {
  const aliases = await getAuthorAliases(author, supabase)

  // Query the view — it's a small result set, fetch all and match in TS
  const { data, error } = await supabase
    .from('author_engagement_scores')
    .select('engagement_score, aliases')

  if (error) {
    console.error('[Scoring] Error fetching author engagement score:', error)
    return null
  }

  if (!data || data.length === 0) return null

  // Find the row whose aliases overlap with our aliases
  const aliasSet = new Set(aliases.map(a => a.toLowerCase()))
  const match = data.find((row: { aliases: string[] }) =>
    row.aliases.some((a: string) => aliasSet.has(a.toLowerCase()))
  )

  if (!match) return null

  return Number(match.engagement_score)
}

/**
 * Get the best available engagement score for a content item.
 *
 * Tries series-level score first (if a series pattern is detected),
 * then falls back to author-level score, then defaults to 0.0.
 */
export async function getEngagementScore(
  title: string,
  author: string,
  supabase: SupabaseClient
): Promise<number> {
  // Try series-level score first
  const seriesKey = extractSeriesKey(title)

  if (seriesKey) {
    const seriesScore = await getSeriesScore(seriesKey, author, supabase)
    if (seriesScore !== null) {
      return seriesScore
    }
  }

  // Fall back to author-level score
  const authorScore = await getAuthorScore(author, supabase)
  if (authorScore !== null) {
    return authorScore
  }

  // Unknown author — neutral default
  return 0.0
}
