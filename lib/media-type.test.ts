import { describe, it, expect } from 'vitest'
import { hasMediaType, isAwcCommentsSource, AUDIO_PLATFORMS, ASKWHOCASTS_PLATFORM, AWC_COMMENTS_LABEL } from './media-type'
import { type QueueItem } from './queue-client'

function itemWithPlatforms(platforms: string[]): QueueItem {
  return {
    sources: platforms.map((platform, i) => ({
      id: i + 1, platform, link: `https://example.com/${i}`, isPrimary: i === 0,
    })),
  } as unknown as QueueItem
}

describe('Askwho Casts audio classification (#226)', () => {
  it('counts an Askwho Casts source as audio', () => {
    expect(AUDIO_PLATFORMS).toContain(ASKWHOCASTS_PLATFORM)
    const item = itemWithPlatforms(['LessWrong', ASKWHOCASTS_PLATFORM])
    expect(hasMediaType(item, 'audio')).toBe(true)
    expect(hasMediaType(item, 'text')).toBe(true)
  })
})

describe('comments episodes (#368)', () => {
  it('does not make a post audio', () => {
    const item = { sources: [
      { id: 1, platform: 'LessWrong', link: 'https://www.lesswrong.com/posts/a/b', isPrimary: true },
      { id: 2, platform: ASKWHOCASTS_PLATFORM, link: 'https://app.askwhocasts.com/c.mp3', isPrimary: false, sourceLabel: AWC_COMMENTS_LABEL },
    ] } as unknown as QueueItem
    expect(hasMediaType(item, 'audio')).toBe(false)
    expect(hasMediaType(item, 'text')).toBe(true)
  })
  it('identifies only the labelled Askwho source', () => {
    expect(isAwcCommentsSource({ platform: ASKWHOCASTS_PLATFORM, sourceLabel: AWC_COMMENTS_LABEL })).toBe(true)
    expect(isAwcCommentsSource({ platform: ASKWHOCASTS_PLATFORM, sourceLabel: null })).toBe(false)
    expect(isAwcCommentsSource({ platform: 'Spotify', sourceLabel: AWC_COMMENTS_LABEL })).toBe(false)
  })
})
