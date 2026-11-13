import { describe, it, expect } from 'vitest'
import {
  parseProgress,
  getPrimarySource,
  getPrimaryPlatform,
  getPrimaryLink,
  effectivePrimarySource,
  getOrderedSources,
  repeatedPlatforms,
  transformToDisplayItem,
  formatLength, heroStartSource } from './transform-utils'
import type { ContentSource, QueueItem } from './queue-client'

// Helper to create mock ContentSource
const createSource = (overrides: Partial<ContentSource> = {}): ContentSource => ({
  id: 1,
  platform: 'Spotify',
  link: 'https://spotify.com/episode/123',
  messageId: null,
  isPrimary: false,
  createdAt: '2025-01-01T00:00:00Z',
  sourceLabel: null,
  ...overrides,
})

describe('parseProgress', () => {
  it('parses "65% complete" to 65', () => {
    expect(parseProgress('65% complete')).toBe(65)
  })

  it('parses "Progress: 30%" to 30', () => {
    expect(parseProgress('Progress: 30%')).toBe(30)
  })

  it('parses plain number "50" to 50', () => {
    expect(parseProgress('50')).toBe(50)
  })

  it('parses "0" to 0', () => {
    expect(parseProgress('0')).toBe(0)
  })

  it('parses "100%" to 100', () => {
    expect(parseProgress('100%')).toBe(100)
  })

  it('returns undefined for null', () => {
    expect(parseProgress(null)).toBeUndefined()
  })

  it('returns undefined for empty string', () => {
    expect(parseProgress('')).toBeUndefined()
  })

  it('returns undefined for text without numbers', () => {
    expect(parseProgress('no numbers here')).toBeUndefined()
  })

  it('returns undefined for values over 100', () => {
    expect(parseProgress('101%')).toBeUndefined()
  })

  it('extracts digits from negative-looking strings (regex behavior)', () => {
    // The regex matches \d+, so "-5" extracts "5"
    expect(parseProgress('-5')).toBe(5)
  })
})

describe('getPrimarySource', () => {
  it('returns source with isPrimary=true', () => {
    const sources = [
      createSource({ id: 1, platform: 'Substack', isPrimary: false }),
      createSource({ id: 2, platform: 'Spotify', isPrimary: true }),
      createSource({ id: 3, platform: 'YouTube', isPrimary: false }),
    ]
    const result = getPrimarySource(sources)
    expect(result?.id).toBe(2)
    expect(result?.platform).toBe('Spotify')
  })

  it('returns first source when no isPrimary flag', () => {
    const sources = [
      createSource({ id: 1, platform: 'Substack' }),
      createSource({ id: 2, platform: 'Spotify' }),
    ]
    const result = getPrimarySource(sources)
    expect(result?.id).toBe(1)
  })

  it('returns null for empty array', () => {
    expect(getPrimarySource([])).toBeNull()
  })

  it('handles single source', () => {
    const sources = [createSource({ id: 1, platform: 'Spotify', isPrimary: true })]
    expect(getPrimarySource(sources)?.platform).toBe('Spotify')
  })
})

describe('getPrimaryPlatform', () => {
  it('returns platform name from primary source', () => {
    const sources = [
      createSource({ platform: 'Substack', isPrimary: false }),
      createSource({ platform: 'Spotify', isPrimary: true }),
    ]
    expect(getPrimaryPlatform(sources)).toBe('Spotify')
  })

  it('returns "Web" for empty array', () => {
    expect(getPrimaryPlatform([])).toBe('Web')
  })

  it('returns first source platform when no primary', () => {
    const sources = [createSource({ platform: 'YouTube' })]
    expect(getPrimaryPlatform(sources)).toBe('YouTube')
  })
})

describe('getPrimaryLink', () => {
  it('returns link from primary source', () => {
    const sources = [
      createSource({ link: 'https://substack.com/1', isPrimary: false }),
      createSource({ link: 'https://spotify.com/2', isPrimary: true }),
    ]
    expect(getPrimaryLink(sources)).toBe('https://spotify.com/2')
  })

  it('returns empty string for empty array', () => {
    expect(getPrimaryLink([])).toBe('')
  })

  it('returns first source link when no primary', () => {
    const sources = [createSource({ link: 'https://example.com' })]
    expect(getPrimaryLink(sources)).toBe('https://example.com')
  })
})

describe('effectivePrimarySource', () => {
  it('returns isPrimary source for queuePosition 1 (LessWrong + Spotify)', () => {
    const sources = [
      createSource({ id: 1, platform: 'LessWrong', isPrimary: false }),
      createSource({ id: 2, platform: 'Spotify', isPrimary: true }),
    ]
    expect(effectivePrimarySource(sources, 1)?.platform).toBe('Spotify')
  })

  it('returns LessWrong for queuePosition 2 (LessWrong + Spotify)', () => {
    const sources = [
      createSource({ id: 1, platform: 'LessWrong', isPrimary: false }),
      createSource({ id: 2, platform: 'Spotify', isPrimary: true }),
    ]
    expect(effectivePrimarySource(sources, 2)?.platform).toBe('LessWrong')
  })

  it('returns the only source for a single-source item at queuePosition 2', () => {
    const sources = [createSource({ id: 1, platform: 'Spotify', isPrimary: true })]
    expect(effectivePrimarySource(sources, 2)?.platform).toBe('Spotify')
  })

  it('falls back to getPrimarySource when no platform matches QUEUE_ITEM_PRIORITY', () => {
    const sources = [
      createSource({ id: 1, platform: 'Patreon', isPrimary: false }),
      createSource({ id: 2, platform: 'Vimeo', isPrimary: true }),
    ]
    // Falls back to isPrimary
    expect(effectivePrimarySource(sources, 2)?.platform).toBe('Vimeo')
  })

  it('returns highest-priority known platform when mixed with unknowns', () => {
    const sources = [
      createSource({ id: 1, platform: 'Patreon', isPrimary: false }),
      createSource({ id: 2, platform: 'YouTube', isPrimary: false }),
    ]
    expect(effectivePrimarySource(sources, 2)?.platform).toBe('YouTube')
  })

  it('treats queuePosition null as non-top (uses QUEUE_ITEM_PRIORITY)', () => {
    const sources = [
      createSource({ id: 1, platform: 'LessWrong', isPrimary: false }),
      createSource({ id: 2, platform: 'Spotify', isPrimary: true }),
    ]
    expect(effectivePrimarySource(sources, null)?.platform).toBe('LessWrong')
  })

  it('returns null for empty sources', () => {
    expect(effectivePrimarySource([], 2)).toBeNull()
    expect(effectivePrimarySource([], 1)).toBeNull()
  })

  it('prefers Substack over Web at queuePosition 2', () => {
    const sources = [
      createSource({ id: 1, platform: 'Web', isPrimary: false }),
      createSource({ id: 2, platform: 'Substack', isPrimary: false }),
    ]
    expect(effectivePrimarySource(sources, 2)?.platform).toBe('Substack')
  })
})

describe('heroStartSource (#364)', () => {
  it('never opens the comments episode (#368)', () => {
    const lw = { id: 1, platform: 'LessWrong', link: 'https://www.lesswrong.com/posts/a/b', isPrimary: true } as never
    const comments = { id: 2, platform: 'Askwho Casts', link: 'https://x/c.mp3', isPrimary: false, sourceLabel: 'Comments' } as never
    const article = { id: 3, platform: 'Askwho Casts', link: 'https://x/a.mp3', isPrimary: false, sourceLabel: null } as never
    expect(heroStartSource([lw, comments])?.id).toBe(1)
    expect(heroStartSource([lw, comments, article])?.id).toBe(3)
  })
  it('opens the Askwho Casts episode when the item has one', () => {
    const sources = [
      createSource({ id: 1, platform: 'Spotify', isPrimary: true }),
      createSource({ id: 2, platform: 'Substack', isPrimary: false }),
      createSource({ id: 3, platform: 'Askwho Casts', isPrimary: false }),
    ]
    expect(heroStartSource(sources)?.id).toBe(3)
  })
  it('uses the primary source otherwise', () => {
    const sources = [
      createSource({ id: 1, platform: 'Substack', isPrimary: false }),
      createSource({ id: 2, platform: 'Spotify', isPrimary: true }),
    ]
    expect(heroStartSource(sources)?.id).toBe(2)
  })
  it('ignores a link-less Askwho Casts row', () => {
    const sources = [
      createSource({ id: 1, platform: 'Spotify', isPrimary: true }),
      createSource({ id: 2, platform: 'Askwho Casts', link: null, isPrimary: false }),
    ]
    expect(heroStartSource(sources)?.id).toBe(1)
  })
  it('is null with no sources', () => {
    expect(heroStartSource([])).toBeNull()
  })
  // The item is waiting on the article and its comments; the listen is finished.
  it('uses the primary source while awaiting comments', () => {
    const sources = [
      createSource({ id: 1, platform: 'LessWrong', isPrimary: true }),
      createSource({ id: 2, platform: 'Askwho Casts', isPrimary: false }),
    ]
    expect(heroStartSource(sources, 'Awaiting comments')?.id).toBe(1)
    expect(heroStartSource(sources, 'In Progress')?.id).toBe(2)
  })
})

describe('getOrderedSources', () => {
  it('sorts Askwho Casts above Spotify (#364)', () => {
    const sources = [
      createSource({ id: 1, platform: 'Spotify', isPrimary: true }),
      createSource({ id: 2, platform: 'Substack', isPrimary: false }),
      createSource({ id: 3, platform: 'Askwho Casts', isPrimary: false }),
    ]
    expect(getOrderedSources(sources, 2).map(s => s.platform)).toEqual(['Substack', 'Askwho Casts', 'Spotify'])
  })
  it('keeps queue cards text-first when an item has an Askwho Casts episode (#364)', () => {
    const sources = [
      createSource({ id: 1, platform: 'Askwho Casts', isPrimary: false }),
      createSource({ id: 2, platform: 'Substack', isPrimary: false }),
    ]
    expect(effectivePrimarySource(sources, 2)?.platform).toBe('Substack')
  })

  it('puts effective primary first, then remaining in priority order (queuePosition 2)', () => {
    const sources = [
      createSource({ id: 1, platform: 'Spotify', isPrimary: true }),
      createSource({ id: 2, platform: 'LessWrong', isPrimary: false }),
      createSource({ id: 3, platform: 'YouTube', isPrimary: false }),
    ]
    const ordered = getOrderedSources(sources, 2)
    expect(ordered.map(s => s.platform)).toEqual(['LessWrong', 'YouTube', 'Spotify'])
  })

  it('puts isPrimary source first at queuePosition 1, rest in priority order', () => {
    const sources = [
      createSource({ id: 1, platform: 'Spotify', isPrimary: true }),
      createSource({ id: 2, platform: 'LessWrong', isPrimary: false }),
      createSource({ id: 3, platform: 'YouTube', isPrimary: false }),
    ]
    const ordered = getOrderedSources(sources, 1)
    expect(ordered.map(s => s.platform)).toEqual(['Spotify', 'LessWrong', 'YouTube'])
  })

  it('appends unknown platforms at the end', () => {
    const sources = [
      createSource({ id: 1, platform: 'Patreon', isPrimary: false }),
      createSource({ id: 2, platform: 'LessWrong', isPrimary: false }),
      createSource({ id: 3, platform: 'YouTube', isPrimary: false }),
    ]
    const ordered = getOrderedSources(sources, 2)
    expect(ordered.map(s => s.platform)).toEqual(['LessWrong', 'YouTube', 'Patreon'])
  })

  it('returns empty array for empty input', () => {
    expect(getOrderedSources([], 2)).toEqual([])
  })

  it('returns single-source item unchanged', () => {
    const sources = [createSource({ id: 1, platform: 'Spotify', isPrimary: true })]
    expect(getOrderedSources(sources, 2).map(s => s.platform)).toEqual(['Spotify'])
  })

  it('preserves duplicate known-platform sources (no silent drops)', () => {
    const sources = [
      createSource({ id: 1, platform: 'Substack', isPrimary: false }),
      createSource({ id: 2, platform: 'YouTube', isPrimary: false }),
      createSource({ id: 3, platform: 'YouTube', isPrimary: false }),
    ]
    const ordered = getOrderedSources(sources, 2)
    expect(ordered).toHaveLength(3)
    // Substack (priority index 1) first, then both YouTubes in input order.
    expect(ordered.map(s => s.id)).toEqual([1, 2, 3])
  })

  it('preserves duplicate unknown-platform sources', () => {
    const sources = [
      createSource({ id: 1, platform: 'YouTube', isPrimary: false }),
      createSource({ id: 2, platform: 'Patreon', isPrimary: false }),
      createSource({ id: 3, platform: 'Patreon', isPrimary: false }),
    ]
    const ordered = getOrderedSources(sources, 2)
    expect(ordered).toHaveLength(3)
    expect(ordered.map(s => s.id)).toEqual([1, 2, 3])
  })
})

describe('repeatedPlatforms (#245)', () => {
  it('returns an empty set for no sources', () => {
    expect(repeatedPlatforms([])).toEqual(new Set())
  })

  it('returns an empty set when every platform is distinct', () => {
    const sources = [
      createSource({ id: 1, platform: 'Substack' }),
      createSource({ id: 2, platform: 'Spotify' }),
      createSource({ id: 3, platform: 'LessWrong' }),
    ]
    expect(repeatedPlatforms(sources)).toEqual(new Set())
  })

  it('flags a platform carried twice (#237 dual Spotify episodes)', () => {
    const sources = [
      createSource({ id: 1, platform: 'Substack' }),
      createSource({ id: 2, platform: 'Spotify' }),
      createSource({ id: 3, platform: 'Spotify' }),
    ]
    expect(repeatedPlatforms(sources)).toEqual(new Set(['Spotify']))
  })

  it('flags every repeated platform independently', () => {
    const sources = [
      createSource({ id: 1, platform: 'Spotify' }),
      createSource({ id: 2, platform: 'Spotify' }),
      createSource({ id: 3, platform: 'YouTube' }),
      createSource({ id: 4, platform: 'YouTube' }),
      createSource({ id: 5, platform: 'Substack' }),
    ]
    expect(repeatedPlatforms(sources)).toEqual(new Set(['Spotify', 'YouTube']))
  })

  it('flags a platform carried three times only once', () => {
    const sources = [
      createSource({ id: 1, platform: 'Spotify' }),
      createSource({ id: 2, platform: 'Spotify' }),
      createSource({ id: 3, platform: 'Spotify' }),
    ]
    expect(repeatedPlatforms(sources)).toEqual(new Set(['Spotify']))
  })
})

describe('transformToDisplayItem', () => {
  it('adds progressPercent from progress text', () => {
    const item: QueueItem = {
      id: 1,
      title: 'Test',
      author: 'Author',
      publishedOn: null,
      status: 'In Progress',
      queuePosition: 1,
      positionConfirmed: true,
      progress: '50% complete',
      createdAt: '2025-01-01',
      updatedAt: '2025-01-01',
      sources: [],
      platform: 'Web',
      link: '',
    }
    const result = transformToDisplayItem(item)
    expect(result.progressPercent).toBe(50)
  })

  it('handles null progress', () => {
    const item: QueueItem = {
      id: 1,
      title: 'Test',
      author: 'Author',
      publishedOn: null,
      status: '',
      queuePosition: null,
      positionConfirmed: false,
      progress: null,
      createdAt: '2025-01-01',
      updatedAt: '2025-01-01',
      sources: [],
      platform: 'Web',
      link: '',
    }
    const result = transformToDisplayItem(item)
    expect(result.progressPercent).toBeUndefined()
  })
})

describe('formatLength', () => {
  it('formats word count as a read estimate at ~225 wpm', () => {
    expect(formatLength({ wordCount: 2250, durationSeconds: null })).toBe('10 min read')
  })

  it('rounds read time and never goes below 1 min', () => {
    expect(formatLength({ wordCount: 50, durationSeconds: null })).toBe('1 min read')
    expect(formatLength({ wordCount: 340, durationSeconds: null })).toBe('2 min read')
  })

  it('formats duration as a listen estimate', () => {
    expect(formatLength({ durationSeconds: 2730, wordCount: null })).toBe('46 min listen')
  })

  it('uses "watch" for YouTube', () => {
    expect(formatLength({ durationSeconds: 600, wordCount: null, platform: 'YouTube' })).toBe('10 min watch')
  })

  it('prefers duration over word count when both are present', () => {
    expect(formatLength({ durationSeconds: 600, wordCount: 5000 })).toBe('10 min listen')
  })

  it('returns null when neither signal is usable', () => {
    expect(formatLength({ wordCount: null, durationSeconds: null })).toBeNull()
    expect(formatLength({ wordCount: 0, durationSeconds: 0 })).toBeNull()
    expect(formatLength({})).toBeNull()
  })
})
