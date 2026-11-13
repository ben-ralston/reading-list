import { describe, it, expect } from 'vitest'
import { detectFeedType } from './detect'

describe('detectFeedType', () => {
  it('detects substack subdomains', () => {
    expect(detectFeedType('https://thezvi.substack.com/feed')).toBe('substack')
  })
  it('detects the bare substack.com host', () => {
    expect(detectFeedType('https://substack.com/feed/something')).toBe('substack')
  })
  it('detects lesswrong.com', () => {
    expect(detectFeedType('https://www.lesswrong.com/feed.xml')).toBe('lesswrong')
  })
  it('detects the legacy buzzsprout lesswrong feed', () => {
    expect(detectFeedType('https://feeds.buzzsprout.com/2037297.rss')).toBe('lesswrong')
  })
  it('falls back to generic for anything else', () => {
    expect(detectFeedType('https://example.com/rss')).toBe('generic')
  })
  it('returns generic for an unparseable URL', () => {
    expect(detectFeedType('not a url')).toBe('generic')
  })
})
