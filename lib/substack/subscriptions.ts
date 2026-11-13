/**
 * Reads the publications a user subscribes to from their public Substack profile.
 *
 * Uses the undocumented but stable public endpoint
 * `GET https://substack.com/api/v1/user/<handle>/public_profile` — no auth required.
 * Only subscriptions the user keeps PUBLIC on their profile are returned, and very large
 * accounts may be truncated (surfaced via the `truncated` flag so callers can decide whether
 * the snapshot is trustworthy enough to act on).
 *
 * Feed URLs are derived in canonical `<subdomain>.substack.com/feed` form and DELIBERATELY
 * ignore `custom_domain`: the subdomain is the stable Substack identity, and using it keeps
 * imported feeds deduped against rows stored in subdomain form. Subdomain feeds resolve even
 * for custom-domain publications (Substack 301-redirects them to the custom domain).
 */

export interface SubstackSub {
  name: string
  subdomain: string
  feedUrl: string
}

interface PublicProfileResponse {
  subscriptions?: Array<{
    publication?: { name?: string; subdomain?: string }
  }>
  subscriptionsTruncated?: boolean
}

const USER_AGENT =
  'Mozilla/5.0 (compatible; reading-list/1.0)'

export async function fetchSubstackSubscriptions(
  handle: string,
): Promise<{ subs: SubstackSub[]; truncated: boolean }> {
  const url = `https://substack.com/api/v1/user/${handle}/public_profile`
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) {
    throw new Error(`Substack public_profile request failed: HTTP ${res.status}`)
  }

  const body = (await res.json()) as PublicProfileResponse
  const subs: SubstackSub[] = []
  for (const sub of body.subscriptions ?? []) {
    const name = sub.publication?.name?.trim()
    const subdomain = sub.publication?.subdomain?.trim().toLowerCase()
    if (!name || !subdomain) continue
    // The subdomain is interpolated into a fetched URL, so validate its shape: a single
    // Substack label (lowercase alphanumeric + hyphen, no dots/slashes/@/:). This both
    // guards against a malformed value resolving to an unexpected host and, via the
    // lowercasing above, keeps URLs deduped against existing subdomain-form rows.
    if (!/^[a-z0-9-]+$/.test(subdomain)) {
      console.warn('[Substack] skipping subscription with invalid subdomain:', subdomain)
      continue
    }
    subs.push({ name, subdomain, feedUrl: `https://${subdomain}.substack.com/feed` })
  }

  return { subs, truncated: !!body.subscriptionsTruncated }
}
