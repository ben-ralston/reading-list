/**
 * SSRF-guarded replacement for rss-parser's parseURL (#206, RLV-017).
 *
 * parseURL does its own HTTP fetching (following redirects, unbounded body),
 * so feed URLs — user-supplied at insert time and re-fetched hourly by the
 * rss-sync cron — bypassed any fetch guard. fetchFeed routes the fetch
 * through safeFetch (private-IP block, per-hop redirect re-validation,
 * timeout) with a body cap, then hands the XML to the caller's parser.
 */

import type Parser from 'rss-parser'
import { readTextCapped, ResponseTooLargeError, safeFetch } from '@/lib/safe-fetch'

const FETCH_TIMEOUT_MS = 10_000

/**
 * Body cap for feeds. Still a bounded DoS guard (#206), but sized for large
 * podcast feeds — a 900+ episode Buzzsprout feed with full show notes runs
 * ~6 MB, which the previous 5 MB cap silently truncated into unparseable XML
 * ("Unclosed root tag", #234). 20 MB leaves headroom while staying bounded.
 *
 * Tradeoff (accepted): the rss-sync cron fetches feeds concurrently and buffers
 * each body fully, so worst-case peak memory is ~MAX_FEED_BYTES × feedCount —
 * 4× the old ceiling. Fine while the feed list stays small; if it grows large,
 * switch to a per-run aggregate byte budget rather than raising this per-feed
 * cap further.
 */
export const MAX_FEED_BYTES = 20 * 1024 * 1024

// What parseURL itself sent (rss-parser/lib/parser.js) — some feed hosts /
// WAFs behave differently on a bare default UA, so preserve these.
const FEED_HEADERS = {
  'User-Agent': 'rss-parser',
  Accept: 'application/rss+xml',
}

export async function fetchFeed<T, U>(
  url: string,
  parser: Parser<T, U>
): Promise<T & Parser.Output<U>> {
  const res = await safeFetch(url, { timeoutMs: FETCH_TIMEOUT_MS, headers: FEED_HEADERS })
  if (!res.ok) {
    throw new Error(`Feed fetch failed with status ${res.status}`)
  }
  let xml: string
  try {
    xml = await readTextCapped(res, MAX_FEED_BYTES, { throwOnCap: true })
  } catch (err) {
    if (err instanceof ResponseTooLargeError) {
      const mb = MAX_FEED_BYTES / (1024 * 1024)
      throw new Error(`Feed exceeds the ${mb} MB size limit — refusing to parse truncated XML`)
    }
    throw err
  }
  return parser.parseString(xml)
}
