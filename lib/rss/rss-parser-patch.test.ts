import { describe, it, expect } from 'vitest'
import RssParser from 'rss-parser'

// #281 F9: rss-parser's utils.stripHtml (/<(?:.|\n)*?>/gm, run on every item's
// content/description to build contentSnippet) is O(n²) on a run of '<' with no
// '>'. patches/rss-parser*.patch swaps in a linear version; this guards it.
describe('rss-parser stripHtml patch', () => {
  it('parses a feed with a pathological description in linear time', async () => {
    const evil = '<'.repeat(60_000)
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>
<item><title>t</title><link>https://ex.com/p</link><description><![CDATA[${evil}]]></description></item>
</channel></rss>`
    const start = performance.now()
    const feed = await new RssParser().parseString(xml)
    expect(performance.now() - start).toBeLessThan(500)
    expect(feed.items).toHaveLength(1)
  })

  it('still strips tags for contentSnippet', async () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>
<item><title>t</title><description><![CDATA[<p>Hello <b>world</b></p>]]></description></item>
</channel></rss>`
    const feed = await new RssParser().parseString(xml)
    expect(feed.items[0].contentSnippet).toBe('Hello world')
  })
})
