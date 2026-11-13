import { describe, it, expect } from 'vitest'
import {
  parseRssItems,
  stripTrackingParams,
  extractLessWrongUrl,
  MAX_AUTHOR_LENGTH,
  MAX_LINK_LENGTH,
  MAX_TITLE_LENGTH,
  type ParserFeed,
  type RssItem,
} from './parser'

// ---------------------------------------------------------------------------
// stripTrackingParams
// ---------------------------------------------------------------------------

describe('stripTrackingParams', () => {
  it('strips utm_ params', () => {
    expect(stripTrackingParams('https://example.com/post?utm_source=rss&utm_medium=email'))
      .toBe('https://example.com/post')
  })

  it('preserves non-tracking params', () => {
    expect(stripTrackingParams('https://example.com/post?id=123&utm_source=rss'))
      .toBe('https://example.com/post?id=123')
  })

  it('handles URLs with no params', () => {
    expect(stripTrackingParams('https://example.com/post'))
      .toBe('https://example.com/post')
  })

  it('handles URLs with only tracking params', () => {
    expect(stripTrackingParams('https://example.com/post?utm_source=rss'))
      .toBe('https://example.com/post')
  })

  it('handles empty string', () => {
    expect(stripTrackingParams('')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// extractLessWrongUrl
// ---------------------------------------------------------------------------

describe('extractLessWrongUrl', () => {
  it('extracts LessWrong URL from description HTML', () => {
    const description = `<p>Some text</p><a href='https://www.lesswrong.com/posts/Dw8mskAvBX37MxvXo/deep-learning-as-program-synthesis-1?utm_source=TYPE_III_AUDIO'>Source</a>`
    expect(extractLessWrongUrl(description))
      .toBe('https://www.lesswrong.com/posts/Dw8mskAvBX37MxvXo/deep-learning-as-program-synthesis-1')
  })

  it('handles double-quoted href', () => {
    const description = `<a href="https://www.lesswrong.com/posts/abc123/test-post?utm_source=foo">Link</a>`
    expect(extractLessWrongUrl(description))
      .toBe('https://www.lesswrong.com/posts/abc123/test-post')
  })

  it('returns null if no LessWrong URL found', () => {
    expect(extractLessWrongUrl('<p>No links here</p>')).toBeNull()
  })

  it('returns null for empty description', () => {
    expect(extractLessWrongUrl('')).toBeNull()
  })

  // Regression tests: real-world failure modes from the audit (issue #135)
  // where the LessWrong URL appears outside of an href attribute.
  it('extracts URL when it appears as anchor text (href points elsewhere)', () => {
    const description = `<a href='https://www.dropbox.com/something'>https://www.lesswrong.com/posts/R3eDrDoX8LisKgGZe/sum-threshold-attacks</a>`
    expect(extractLessWrongUrl(description))
      .toBe('https://www.lesswrong.com/posts/R3eDrDoX8LisKgGZe/sum-threshold-attacks')
  })

  it('extracts URL when it appears as anchor text (href is a relative path)', () => {
    const description = `<a href='/sequences/aiforethought'>https://www.lesswrong.com/posts/pHfPvb4JMhGDr4B7n/recursive-middle-manager-hell</a>`
    expect(extractLessWrongUrl(description))
      .toBe('https://www.lesswrong.com/posts/pHfPvb4JMhGDr4B7n/recursive-middle-manager-hell')
  })

  it('extracts bare URL in plain text (no anchor at all)', () => {
    const description = `<p>https://www.lesswrong.com/posts/jDQm7YJxLnMnSNHFu/moral-strategies-at-different-capability-levels</p>`
    expect(extractLessWrongUrl(description))
      .toBe('https://www.lesswrong.com/posts/jDQm7YJxLnMnSNHFu/moral-strategies-at-different-capability-levels')
  })

  it('strips tracking params from bare URLs', () => {
    const description = `<p>https://www.lesswrong.com/posts/abc123/post?utm_source=foo&utm_medium=bar</p>`
    expect(extractLessWrongUrl(description))
      .toBe('https://www.lesswrong.com/posts/abc123/post')
  })

  it('still prefers href-prefixed URL when both forms exist in description', () => {
    // If an href to a LW URL is present, it's the authoritative source; a
    // bare URL in text (e.g., a footnote) should not override it.
    const description = `<a href='https://www.lesswrong.com/posts/CANONICAL/link'>read here</a> see also https://www.lesswrong.com/posts/OTHER/link`
    expect(extractLessWrongUrl(description))
      .toBe('https://www.lesswrong.com/posts/CANONICAL/link')
  })
})

// ---------------------------------------------------------------------------
// parseRssItems
// ---------------------------------------------------------------------------

describe('parseRssItems', () => {
  const substackConfig: ParserFeed = {
    feedType: 'substack',
    authorName: 'Zvi Mowshowitz',
    platform: 'Substack',
  }

  const lesswrongConfig: ParserFeed = {
    feedType: 'lesswrong',
    authorName: 'LessWrong (Curated & Popular)',
    platform: 'LessWrong',
  }

  // #281: feed fields are attacker-controlled and flow into regex-heavy
  // matching/scoring and every queue render, so bound them at ingest.
  describe('untrusted field bounds (#281)', () => {
    const genericConfig: ParserFeed = { feedType: 'generic', platform: 'Blog' }

    it('truncates oversized titles and authors', () => {
      const [item] = parseRssItems(
        [{ title: 'T'.repeat(5000), creator: 'A'.repeat(5000), link: 'https://ex.com/p' }],
        genericConfig
      )
      expect(item.title).toHaveLength(MAX_TITLE_LENGTH)
      expect(item.author).toHaveLength(MAX_AUTHOR_LENGTH)
    })

    it('does not throw on a non-string creator (structured dc:creator)', () => {
      const result = parseRssItems(
        [{ title: 'ok', creator: { name: ['Bob'] } as unknown as string, link: 'https://ex.com/p' }],
        genericConfig
      )
      expect(result).toHaveLength(1)
    })

    it('drops items whose link is absurdly long', () => {
      const result = parseRssItems(
        [
          { title: 'ok', link: 'https://ex.com/p' },
          { title: 'huge', link: `https://ex.com/${'a'.repeat(MAX_LINK_LENGTH)}` },
        ],
        genericConfig
      )
      expect(result.map((r) => r.title)).toEqual(['ok'])
    })
  })

  describe('Substack items', () => {
    it('parses a basic Substack RSS item', () => {
      const items = [{
        title: 'AI Safety Is Not A Fad',
        link: 'https://thezvi.substack.com/p/ai-safety-is-not-a-fad',
        pubDate: 'Mon, 25 Mar 2026 12:00:00 GMT',
        isoDate: '2026-03-25T12:00:00.000Z',
      }]

      const result = parseRssItems(items, substackConfig)

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        title: 'AI Safety Is Not A Fad',
        author: 'Zvi Mowshowitz',
        platform: 'Substack',
        link: 'https://thezvi.substack.com/p/ai-safety-is-not-a-fad',
        publishedOn: '2026-03-25',
        // A bare item (no content/enclosure/itunes) yields null enrichment (#167).
        imageUrl: null,
        wordCount: null,
        durationSeconds: null,
      })
    })

    it('strips tracking params from links', () => {
      const items = [{
        title: 'Test Post',
        link: 'https://thezvi.substack.com/p/test?utm_source=rss&utm_medium=reader2',
        pubDate: 'Mon, 25 Mar 2026 12:00:00 GMT',
        isoDate: '2026-03-25T12:00:00.000Z',
      }]

      const result = parseRssItems(items, substackConfig)
      expect(result[0].link).toBe('https://thezvi.substack.com/p/test')
    })

    it('skips items without title', () => {
      const items = [{
        title: '',
        link: 'https://thezvi.substack.com/p/test',
        pubDate: 'Mon, 25 Mar 2026 12:00:00 GMT',
        isoDate: '2026-03-25T12:00:00.000Z',
      }]

      const result = parseRssItems(items, substackConfig)
      expect(result).toHaveLength(0)
    })

    it('handles missing pubDate by omitting publishedOn', () => {
      const items = [{
        title: 'No Date Post',
        link: 'https://thezvi.substack.com/p/no-date',
      }]

      const result = parseRssItems(items, substackConfig)
      expect(result[0].publishedOn).toBeUndefined()
    })
  })

  describe('LessWrong items', () => {
    it('parses a LessWrong Buzzsprout item', () => {
      const items = [{
        title: '"Deep learning as program synthesis" by Zach Furman',
        link: 'https://www.buzzsprout.com/2037297/episodes/123',
        content: `<p>Text</p><a href='https://www.lesswrong.com/posts/Dw8mskAvBX37MxvXo/deep-learning-as-program-synthesis-1?utm_source=TYPE_III_AUDIO'>Source</a>`,
        pubDate: 'Tue, 26 Mar 2026 08:00:00 GMT',
        isoDate: '2026-03-26T08:00:00.000Z',
      }]

      const result = parseRssItems(items, lesswrongConfig)

      expect(result).toHaveLength(1)
      // toMatchObject (not toEqual) so the test stays focused on LessWrong URL
      // extraction and isn't coupled to the incidental enrichment values (#167)
      // derived from the Buzzsprout description.
      expect(result[0]).toMatchObject({
        title: '"Deep learning as program synthesis" by Zach Furman',
        author: 'LessWrong (Curated & Popular)',
        platform: 'LessWrong',
        link: 'https://www.lesswrong.com/posts/Dw8mskAvBX37MxvXo/deep-learning-as-program-synthesis-1',
        publishedOn: '2026-03-26',
      })
    })

    it('falls back to Buzzsprout link if no LessWrong URL in description', () => {
      const items = [{
        title: '"Some post" by Author',
        link: 'https://www.buzzsprout.com/2037297/episodes/456',
        content: '<p>No LessWrong link here</p>',
        pubDate: 'Tue, 26 Mar 2026 08:00:00 GMT',
        isoDate: '2026-03-26T08:00:00.000Z',
      }]

      const result = parseRssItems(items, lesswrongConfig)
      expect(result[0].link).toBe('https://www.buzzsprout.com/2037297/episodes/456')
    })

    it('returns empty link when neither LessWrong URL nor item.link is present', () => {
      // Real Buzzsprout behavior: some items lack an item-level <link>, and
      // their description has no lesswrong.com/posts/ URL. Parser emits the
      // item with link='' — the sync route is responsible for filtering.
      const items = [{
        title: '"Orphan episode" by Author',
        content: '<p>No LessWrong link here</p>',
        pubDate: 'Tue, 26 Mar 2026 08:00:00 GMT',
        isoDate: '2026-03-26T08:00:00.000Z',
      }]

      const result = parseRssItems(items, lesswrongConfig)
      expect(result).toHaveLength(1)
      expect(result[0].link).toBe('')
    })
  })

  describe('multiple items', () => {
    it('parses multiple items from the same feed', () => {
      const items = [
        {
          title: 'Post One',
          link: 'https://thezvi.substack.com/p/one',
          isoDate: '2026-03-25T12:00:00.000Z',
        },
        {
          title: 'Post Two',
          link: 'https://thezvi.substack.com/p/two',
          isoDate: '2026-03-26T12:00:00.000Z',
        },
      ]

      const result = parseRssItems(items, substackConfig)
      expect(result).toHaveLength(2)
      expect(result[0].title).toBe('Post One')
      expect(result[1].title).toBe('Post Two')
    })
  })
})

describe('parseRssItems — generic', () => {
  const generic: ParserFeed = { feedType: 'generic', authorName: 'Fallback Author', platform: 'RSS' }

  it('uses dc:creator when present', () => {
    const items = [{ title: 'Post', link: 'https://e.com/p?utm_source=x', 'dc:creator': 'Jane Doe' }]
    const [out] = parseRssItems(items as RssItem[], generic)
    expect(out).toMatchObject({ title: 'Post', author: 'Jane Doe', platform: 'RSS', link: 'https://e.com/p' })
  })

  it('falls back to the feed authorName then Unknown', () => {
    const [a] = parseRssItems([{ title: 'A', link: 'https://e.com/a' }] as RssItem[], generic)
    expect(a.author).toBe('Fallback Author')
    const [b] = parseRssItems([{ title: 'B', link: 'https://e.com/b' }] as RssItem[],
      { ...generic, authorName: null })
    expect(b.author).toBe('Unknown')
  })
})
