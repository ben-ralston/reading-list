/**
 * Linear-time HTML scanning helpers (#281).
 *
 * Feed bodies, feed-linked pages and shared URLs are attacker-controlled HTML
 * of up to several MB. The backtracking regexes these replace
 * (`/<[^>]+>/g`, `/<script\b[^>]*>[\s\S]*?<\/script>/`, `/<meta\b[^>]*>/g`,
 * `/<head[^>]*>([\s\S]*?)<\/head>/`) are O(n²) on unclosed input such as a long
 * run of '<' — enough to stall a serverless function until it is killed (ReDoS,
 * CWE-1333). Everything here is a forward scan with indexOf, and every "no
 * closing token after position p" result is remembered so it is never
 * re-searched, which keeps each helper O(n).
 *
 * Not a parser: just enough to strip tags for a word count and pull attributes
 * out of <meta>/<head>/<body>/<title>, matching the old regexes' behaviour.
 */

/** Tags longer than this are skipped by getAttribute (no real <meta> is this long). */
export const MAX_TAG_LENGTH = 4096

/** ASCII-only lowercase: same length as the input, so indexes line up. */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase())
}

function isNameChar(ch: string | undefined): boolean {
  return ch !== undefined && /[a-z0-9_-]/i.test(ch)
}

/** Index just past `<name` at `at` when `name` is followed by a non-name char, else -1. */
function openerEnd(lower: string, at: number, name: string): number {
  if (!lower.startsWith(name, at + 1)) return -1
  const end = at + 1 + name.length
  return isNameChar(lower[end]) ? -1 : end
}

/**
 * Replace every tag with a space and drop <script>/<style> blocks entirely.
 * An unclosed <script>/<style> opener is treated as an ordinary tag, and a '<'
 * with no later '>' is left as text — both as the old regex chain did.
 */
export function stripTags(html: string): string {
  const lower = asciiLower(html)
  const out: string[] = []
  // Once a search for a closer fails, no later position can succeed either.
  const noCloser: Record<string, boolean> = {}
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt === -1) {
      out.push(html.slice(i))
      break
    }
    out.push(html.slice(i, lt))
    const gt = html.indexOf('>', lt + 1)
    if (gt === -1) {
      // No '>' anywhere after: nothing further can be a tag.
      out.push(html.slice(lt))
      break
    }
    if (gt === lt + 1) {
      // '<>' is not a tag (the old regex needed at least one char).
      out.push('<')
      i = lt + 1
      continue
    }
    let next = gt + 1
    for (const block of ['script', 'style']) {
      if (openerEnd(lower, lt, block) === -1 || noCloser[block]) continue
      const close = lower.indexOf(`</${block}>`, gt + 1)
      if (close === -1) {
        noCloser[block] = true
      } else {
        next = close + block.length + 3
      }
      break
    }
    out.push(' ')
    i = next
  }
  return out.join('')
}

/** Every opening tag `<name ...>` (case-insensitive, `<metadata>` excluded for 'meta'). */
export function findTags(html: string, name: string): string[] {
  const lower = asciiLower(html)
  const needle = `<${name.toLowerCase()}`
  const tags: string[] = []
  let from = 0
  for (;;) {
    const lt = lower.indexOf(needle, from)
    if (lt === -1) break
    if (openerEnd(lower, lt, name.toLowerCase()) === -1) {
      from = lt + 1
      continue
    }
    const gt = html.indexOf('>', lt + 1)
    if (gt === -1) break
    tags.push(html.slice(lt, gt + 1))
    from = gt + 1
  }
  return tags
}

/** A quoted attribute's value from one tag, or null. Skips oversized tags. */
export function getAttribute(tag: string, name: string): string | null {
  if (tag.length > MAX_TAG_LENGTH) return null
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = tag.match(new RegExp(`(?:^|[\\s<])${escaped}\\s*=\\s*["']([^"']*)["']`, 'i'))
  return m ? m[1] : null
}

/**
 * Content between the first `<name ...>` and the following `</name>`. With
 * allowUnclosed, a missing closer returns everything after the opener.
 */
export function innerTextOf(
  html: string,
  name: string,
  opts: { allowUnclosed?: boolean } = {}
): string | null {
  const lower = asciiLower(html)
  const n = name.toLowerCase()
  let from = 0
  for (;;) {
    const lt = lower.indexOf(`<${n}`, from)
    if (lt === -1) return null
    if (openerEnd(lower, lt, n) === -1) {
      from = lt + 1
      continue
    }
    const gt = html.indexOf('>', lt + 1)
    if (gt === -1) return null
    const close = lower.indexOf(`</${n}`, gt + 1)
    if (close === -1) return opts.allowUnclosed ? html.slice(gt + 1) : null
    return html.slice(gt + 1, close)
  }
}
