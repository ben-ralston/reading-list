// Navigation guard for the awc-agent session (#317 review). The agent drives
// a signed-in Chrome profile while reading attacker-influenced pages; the
// prompt tells it to stay on Askwho Casts and the item's own site. This
// enforces that for explicit `navigate` calls in two places: the PreToolUse
// hook (src/nav-hook.ts) denies the call before it runs, and the daemon's
// stream watcher kills the session as a backstop. (Link clicks via
// `computer` are not covered — see awc-agent/README.md, "Isolation".)

const AWC_HOSTS = ['app.askwhocasts.com', 'askwhocasts.com', 'www.askwhocasts.com']
const NAVIGATE_TOOL = 'mcp__claude-in-chrome__navigate'

function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '')
}

export function allowedHostsFor(itemUrl: string): Set<string> {
  const allowed = new Set(AWC_HOSTS)
  try {
    const host = bareHost(new URL(itemUrl).host)
    allowed.add(host)
    allowed.add(`www.${host}`)
  } catch {
    // Unparseable item URL: only Askwho Casts is allowed.
  }
  return allowed
}

// Returns the offending host when a tool call navigates off the allowlist,
// null when the call is fine (or isn't a URL navigation at all).
export function navigationViolation(
  toolName: string,
  input: Record<string, unknown>,
  allowed: Set<string>,
): string | null {
  if (toolName !== NAVIGATE_TOOL) return null
  const url = input.url
  if (typeof url !== 'string' || url === '') return 'missing url'
  // History navigation can return to a page reached by a click; the agent's
  // workflow never needs it.
  if (url === 'back' || url === 'forward') return 'history navigation'
  // Fail closed on anything another URL parser (the extension, Chrome) might
  // read differently from WHATWG URL: whitespace, backslashes, controls.
  if (/[\s\\\u0000-\u001f\u007f]/.test(url)) return 'malformed url'
  let parsed: URL
  try {
    // navigate defaults a bare host to https://, so mirror that.
    parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`)
  } catch {
    return url.slice(0, 80)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return parsed.protocol
  return allowed.has(parsed.host.toLowerCase()) ? null : parsed.host.toLowerCase()
}
