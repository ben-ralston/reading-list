import { describe, it, expect } from 'vitest'
import { findTags, getAttribute, innerTextOf, stripTags } from './html-scan'

/** Run fn and return elapsed ms. */
function time(fn: () => unknown): number {
  const start = performance.now()
  fn()
  return performance.now() - start
}

describe('stripTags', () => {
  it('replaces tags with spaces and drops script/style blocks', () => {
    expect(stripTags('<p>one</p><script>var x</script><style>a{}</style>two').split(/\s+/).filter(Boolean)).toEqual([
      'one',
      'two',
    ])
  })

  it('keeps an unclosed script opener as a plain tag (matches the old regex)', () => {
    expect(stripTags('<script>alpha beta').trim()).toBe('alpha beta')
  })

  it('is case-insensitive for script/style', () => {
    expect(stripTags('<SCRIPT type="x">bad</SCRIPT>ok').trim()).toBe('ok')
  })

  it('leaves a stray < with no closing > as text', () => {
    expect(stripTags('a < b').trim()).toBe('a < b')
  })

  it('runs in linear time on unclosed tags (#281 ReDoS)', () => {
    const lt = '<'.repeat(200_000)
    const scripts = '<script>'.repeat(30_000)
    expect(time(() => stripTags(lt))).toBeLessThan(100)
    expect(time(() => stripTags(scripts))).toBeLessThan(100)
  })
})

describe('findTags', () => {
  it('returns each opening tag of the given name', () => {
    const html = '<head><meta a="1"><metadata x><META b="2"/></head>'
    expect(findTags(html, 'meta')).toEqual(['<meta a="1">', '<META b="2"/>'])
  })

  it('runs in linear time on unclosed tags (#281 ReDoS)', () => {
    expect(time(() => findTags('<meta '.repeat(50_000), 'meta'))).toBeLessThan(100)
  })
})

describe('getAttribute', () => {
  it('reads quoted attribute values case-insensitively', () => {
    expect(getAttribute('<meta PROPERTY="og:image" content=\'x.jpg\'>', 'property')).toBe('og:image')
    expect(getAttribute('<meta property="og:image" content=\'x.jpg\'>', 'content')).toBe('x.jpg')
    expect(getAttribute('<meta data-property="z">', 'property')).toBeNull()
  })

  it('ignores absurdly long tags', () => {
    expect(getAttribute(`<meta name="a" ${' '.repeat(10_000)}>`, 'name')).toBeNull()
  })
})

describe('innerTextOf', () => {
  it('returns the content between the first open tag and its close', () => {
    expect(innerTextOf('<html><head x="1"><title>T</title></head><body>B</body>', 'head')).toBe('<title>T</title>')
    expect(innerTextOf('<header>no</header>', 'head')).toBeNull()
  })

  it('returns everything after the open tag when allowUnclosed', () => {
    expect(innerTextOf('<body class="a">hello', 'body', { allowUnclosed: true })).toBe('hello')
    expect(innerTextOf('<body class="a">hello', 'body')).toBeNull()
  })

  it('runs in linear time (#281 ReDoS)', () => {
    expect(time(() => innerTextOf('<head>'.repeat(100_000), 'head'))).toBeLessThan(100)
    expect(time(() => innerTextOf('<head'.repeat(100_000), 'head'))).toBeLessThan(100)
  })
})
