import { describe, it, expect } from 'vitest'
import { handoffTarget } from '@/lib/links'
import { LINK_LAB_GROUPS, type LinkLabCase } from './fixtures'

const allCases: LinkLabCase[] = LINK_LAB_GROUPS.flatMap((g) => g.cases)

describe('link lab fixtures', () => {
  // The whole point of the page is to be a truthful mirror of the registry: a
  // row that claims "should reach the Substack app" while externalHref would
  // actually x-safari it makes the on-device results meaningless (#267).
  it('every fixture s expected destination matches the registry', () => {
    for (const c of allCases) {
      expect(handoffTarget(c.url), `${c.label} (${c.url})`).toBe(c.expected)
    }
  })

  // #281 F6: this module ships in the client bundle. The second path segment
  // of an app.askwhocasts.com/f/<segment>/ URL is a private-feed bearer secret
  // (lib/sync/redact.ts), so fixtures must only ever carry a placeholder.
  it('never embeds a real Askwho Casts feed secret', () => {
    for (const c of allCases) {
      const m = c.url.match(/askwhocasts\.com\/f\/([^/]+)/)
      if (m) expect(m[1], c.label).toBe('notasecret')
    }
  })

  it('covers every app the registry can hand off to', () => {
    const covered = new Set(allCases.map((c) => c.expected).filter(Boolean))
    expect(covered).toEqual(
      new Set(['Substack', 'Spotify', 'Apple Podcasts', 'YouTube', 'Goodreads', 'Audible']),
    )
  })

  // Controls prove the x-safari- escape still works; without a known-null row
  // an all-in-app-sheet result would be indistinguishable from a broken escape.
  it('includes Safari controls that must not match any app', () => {
    const controls = allCases.filter((c) => c.expected === null)
    expect(controls.length).toBeGreaterThanOrEqual(2)
  })

  it('uses https urls only, since universal links are https-only', () => {
    for (const c of allCases) expect(c.url.startsWith('https://'), c.label).toBe(true)
  })

  it('gives every case a unique label so on-device notes are unambiguous', () => {
    expect(new Set(allCases.map((c) => c.label)).size).toBe(allCases.length)
  })
})
