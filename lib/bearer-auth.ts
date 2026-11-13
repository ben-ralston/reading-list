import { timingSafeEqual } from 'crypto'

/**
 * Constant-time check that an `Authorization` header equals `Bearer <secret>`.
 *
 * RLV-016: the cron routes (rss-sync, spotify-sync, substack-import) are the only
 * external gate for `SYNC_API_SECRET` and were still using a plain `===` compare,
 * which short-circuits on the first differing byte and leaks match length via
 * response timing. /api/sync and /api/add-entry were hardened to timingSafeEqual
 * in e1641e3; this helper carries the same guarantee to every bearer-checked route.
 *
 * Returns false (never throws) for a missing header or an unset/empty secret.
 */
export function bearerTokenMatches(
  authHeader: string | null,
  secret: string | undefined,
): boolean {
  if (!authHeader || !secret) return false
  const provided = Buffer.from(authHeader)
  const expected = Buffer.from(`Bearer ${secret}`)
  // timingSafeEqual throws on differing lengths; the length guard is inherently
  // non-secret (header length is observable regardless).
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}
