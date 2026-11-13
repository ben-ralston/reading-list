/**
 * Redacts a bearer-secret feed URL — AND the secret path segment embedded
 * within it — from arbitrary text before it is logged or stored (#226, #238).
 *
 * Askwho Casts feed URLs look like https://app.askwhocasts.com/f/<secret>/feed.xml
 * (the secret is the second path segment). Enclosure URLs
 * (.../f/<secret>/media/x.mp3) carry the SAME secret at the same path position
 * but a different full URL string, so redacting only the literal feed URL would
 * not catch them — the secret segment must be redacted independently. Plain
 * literal replace, no regex.
 */
/**
 * True when `url` points at Askwho Casts (app.askwhocasts.com) — the only sync
 * links whose path embeds a bearer secret. Used to gate secret redaction so
 * ordinary RSS article URLs, whose path segments are not secrets, log in full.
 */
export function isAskwhocastsUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return hostname === 'askwhocasts.com' || hostname.endsWith('.askwhocasts.com')
  } catch {
    return false
  }
}

export function redactFeedSecret(text: string, feedUrl: string | undefined): string {
  if (!feedUrl) return text
  let result = text.split(feedUrl).join('[feed-url]')
  try {
    const secretSegment = new URL(feedUrl).pathname.split('/')[2]
    if (secretSegment) {
      result = result.split(secretSegment).join('[feed-secret]')
    }
  } catch {
    // Malformed feed URL — nothing more we can extract to redact.
  }
  return result
}
