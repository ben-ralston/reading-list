import { describe, it, expect } from 'vitest'
import { redactFeedSecret } from './redact'

const FEED_URL = 'https://app.askwhocasts.com/f/SECRET123/feed.xml'

describe('redactFeedSecret', () => {
  it('redacts the literal feed URL', () => {
    const text = `fetch failed for ${FEED_URL}`
    expect(redactFeedSecret(text, FEED_URL)).toBe('fetch failed for [feed-url]')
  })

  it('redacts the bearer-secret path segment even inside a different URL (enclosure)', () => {
    // Enclosure URLs carry the SAME secret at the same path position but a
    // different full string, so literal-URL replacement alone would miss it.
    const enclosure = 'https://app.askwhocasts.com/f/SECRET123/media/x.mp3'
    expect(redactFeedSecret(`insert failed: ${enclosure}`, FEED_URL)).toBe(
      'insert failed: https://app.askwhocasts.com/f/[feed-secret]/media/x.mp3'
    )
  })

  it('returns text unchanged when no feed URL is provided', () => {
    expect(redactFeedSecret('some error', undefined)).toBe('some error')
  })

  it('still redacts the literal URL when the URL is malformed (no secret segment)', () => {
    expect(redactFeedSecret('boom not-a-url here', 'not-a-url')).toBe('boom [feed-url] here')
  })
})
