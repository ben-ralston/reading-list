import { describe, it, expect } from 'vitest'
import {
  calculateProgress,
  determineStatus,
  normalizeShowName,
  spotifyShowLabel,
  normalizeSpotifyDate,
  hasProgress,
  transformToSyncItems,
} from './transform'
import type { SavedEpisode } from './client'

describe('calculateProgress', () => {
  it('should calculate progress percentage correctly', () => {
    expect(calculateProgress(300000, 600000)).toBe(50) // 50%
    expect(calculateProgress(900000, 3600000)).toBe(25) // 25%
    expect(calculateProgress(600000, 600000)).toBe(100) // 100%
  })

  it('should round to nearest integer', () => {
    expect(calculateProgress(333333, 1000000)).toBe(33) // 33.33% → 33
    expect(calculateProgress(666666, 1000000)).toBe(67) // 66.66% → 67
  })

  it('should handle zero resume position', () => {
    expect(calculateProgress(0, 600000)).toBe(0)
  })

  it('should handle zero duration (edge case)', () => {
    expect(calculateProgress(100000, 0)).toBe(0)
  })

  it('should clamp to 100% max', () => {
    // Edge case: resume position > duration (shouldn't happen but defensive)
    expect(calculateProgress(700000, 600000)).toBe(100)
  })

  it('should clamp to 0% min', () => {
    // Edge case: negative values (shouldn't happen but defensive)
    expect(calculateProgress(-100000, 600000)).toBe(0)
  })
})

describe('determineStatus', () => {
  it('should return Completed when fully_played is true', () => {
    expect(determineStatus(0, true)).toBe('Completed')
    expect(determineStatus(50, true)).toBe('Completed')
  })

  it('should return Completed when progress >= 95%', () => {
    expect(determineStatus(95, false)).toBe('Completed')
    expect(determineStatus(97, false)).toBe('Completed')
    expect(determineStatus(99, false)).toBe('Completed')
    expect(determineStatus(100, false)).toBe('Completed')
  })

  it('should return empty string when progress is 1% or less', () => {
    expect(determineStatus(0, false)).toBe('')
    expect(determineStatus(1, false)).toBe('')
  })

  it('should return In Progress when progress > 1% and < 95%', () => {
    expect(determineStatus(2, false)).toBe('In Progress')
    expect(determineStatus(50, false)).toBe('In Progress')
    expect(determineStatus(94, false)).toBe('In Progress')
  })

  it('should prioritize fully_played over progress', () => {
    // Even if progress is low, fully_played=true means Completed
    expect(determineStatus(10, true)).toBe('Completed')
  })

  // Near-end rule: stopping just before the outro/credits stranded items at
  // 86-96% forever ("In Progress" zombies). Two minutes or less remaining
  // counts as done — but only past 80% progress, so a short episode barely
  // started is never falsely completed.
  describe('near-end completion', () => {
    it('completes when 2 minutes or less remain and progress >= 80%', () => {
      expect(determineStatus(88, false, 72_000)).toBe('Completed')
      expect(determineStatus(80, false, 120_000)).toBe('Completed')
    })

    it('stays In Progress when more than 2 minutes remain', () => {
      expect(determineStatus(88, false, 300_000)).toBe('In Progress')
    })

    it('stays In Progress under the 80% floor even with little time left', () => {
      expect(determineStatus(40, false, 90_000)).toBe('In Progress')
    })
  })
})

describe('normalizeShowName', () => {
  it('should strip " Podcast" suffix', () => {
    expect(normalizeShowName('80,000 Hours Podcast')).toBe('80,000 Hours')
  })

  it('should strip " The Podcast" suffix', () => {
    expect(normalizeShowName("Don't Worry About the Vase The Podcast")).toBe(
      "Don't Worry About the Vase"
    )
  })

  it('should strip " - The Podcast" suffix', () => {
    expect(normalizeShowName('Some Show - The Podcast')).toBe('Some Show')
  })

  it('should strip " Show" suffix', () => {
    expect(normalizeShowName('The Daily Show')).toBe('The Daily')
  })

  it('should strip " Audio" suffix', () => {
    expect(normalizeShowName('TED Talks Audio')).toBe('TED Talks')
  })

  it('should be case-insensitive for suffix matching', () => {
    expect(normalizeShowName('My Show PODCAST')).toBe('My Show')
    expect(normalizeShowName('Another Show podcast')).toBe('Another Show')
  })

  it('should trim whitespace', () => {
    expect(normalizeShowName('  Hardcore History  ')).toBe('Hardcore History')
  })

  it('should not modify names without suffixes', () => {
    expect(normalizeShowName('The Joe Rogan Experience')).toBe('The Joe Rogan Experience')
    expect(normalizeShowName('Hardcore History')).toBe('Hardcore History')
  })

  it('should handle null or undefined show names', () => {
    expect(normalizeShowName(null)).toBe('Unknown Show')
    expect(normalizeShowName(undefined)).toBe('Unknown Show')
  })

  describe('spotifyShowLabel (#245)', () => {
    it('returns a real show name unchanged', () => {
      expect(spotifyShowLabel('AI Article Readings')).toBe('AI Article Readings')
    })

    it('maps the Unknown Show sentinel to null (never a persisted label)', () => {
      expect(spotifyShowLabel(normalizeShowName(null))).toBeNull()
      expect(spotifyShowLabel('Unknown Show')).toBeNull()
    })

    it('maps empty, whitespace, null, and undefined to null', () => {
      expect(spotifyShowLabel('')).toBeNull()
      expect(spotifyShowLabel('   ')).toBeNull()
      expect(spotifyShowLabel(null)).toBeNull()
      expect(spotifyShowLabel(undefined)).toBeNull()
    })

    it('trims surrounding whitespace', () => {
      expect(spotifyShowLabel('  Astral Codex Ten  ')).toBe('Astral Codex Ten')
    })
  })

  it('should only remove one suffix (not multiple)', () => {
    // Edge case: "Show Podcast" should only remove "Podcast"
    expect(normalizeShowName('The Show Podcast')).toBe('The Show')
  })
})

describe('normalizeSpotifyDate', () => {
  it('should convert YYYY-MM-DD to noon UTC', () => {
    expect(normalizeSpotifyDate('2024-03-15')).toBe('2024-03-15T12:00:00Z')
    expect(normalizeSpotifyDate('2025-12-31')).toBe('2025-12-31T12:00:00Z')
  })

  it('should convert YYYY-MM to first of month at noon UTC', () => {
    expect(normalizeSpotifyDate('2024-03')).toBe('2024-03-01T12:00:00Z')
    expect(normalizeSpotifyDate('2025-12')).toBe('2025-12-01T12:00:00Z')
  })

  it('should convert YYYY to January 1st at noon UTC', () => {
    expect(normalizeSpotifyDate('2024')).toBe('2024-01-01T12:00:00Z')
    expect(normalizeSpotifyDate('2025')).toBe('2025-01-01T12:00:00Z')
  })

  it('should return undefined for null/undefined', () => {
    expect(normalizeSpotifyDate(null)).toBeUndefined()
    expect(normalizeSpotifyDate(undefined)).toBeUndefined()
  })

  it('should return undefined for invalid "0000" dates', () => {
    expect(normalizeSpotifyDate('0000')).toBeUndefined()
    expect(normalizeSpotifyDate('0000-00-00')).toBeUndefined()
  })

  it('should return undefined for unknown formats', () => {
    expect(normalizeSpotifyDate('March 15, 2024')).toBeUndefined()
    expect(normalizeSpotifyDate('15-03-2024')).toBeUndefined()
    expect(normalizeSpotifyDate('invalid')).toBeUndefined()
  })
})

describe('hasProgress', () => {
  it('should return true when fully_played is true', () => {
    const episode = createMockSavedEpisode({
      resume_position_ms: 0,
      fully_played: true,
    })
    expect(hasProgress(episode)).toBe(true)
  })

  it('should return true when resume_position_ms > 0', () => {
    const episode = createMockSavedEpisode({
      resume_position_ms: 100000,
      fully_played: false,
    })
    expect(hasProgress(episode)).toBe(true)
  })

  it('should return false when no progress and not fully played', () => {
    const episode = createMockSavedEpisode({
      resume_position_ms: 0,
      fully_played: false,
    })
    expect(hasProgress(episode)).toBe(false)
  })

  it('should return false when resume_point is undefined', () => {
    const episode = createMockSavedEpisode({})
    // Simulate missing resume_point (can happen with some Spotify responses)
    ;(episode.episode as unknown as { resume_point: undefined }).resume_point = undefined
    expect(hasProgress(episode)).toBe(false)
  })
})

describe('transformToSyncItems', () => {
  it('should transform episodes to sync items', () => {
    const episodes: SavedEpisode[] = [
      createMockSavedEpisode({
        id: 'abc123',
        name: 'Episode 1',
        show_name: '80,000 Hours Podcast',
        duration_ms: 3600000, // 1 hour
        resume_position_ms: 1800000, // 30 minutes = 50%
        fully_played: false,
        release_date: '2024-03-15',
      }),
    ]

    const result = transformToSyncItems(episodes)

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      title: 'Episode 1',
      author: '80,000 Hours', // Normalized (stripped " Podcast")
      platform: 'Spotify',
      link: 'https://open.spotify.com/episode/abc123',
      progress: '50',
      status: 'In Progress',
      externalId: 'spotify:episode:abc123',
      publishedOn: '2024-03-15T12:00:00Z',
      imageUrl: null, // no images on this mock episode
      durationSeconds: 3600, // 3600000 ms / 1000
      savedAt: '2024-01-01T00:00:00Z', // added_at, for the back-catalog guard (#305)
    })
  })

  it('marks an episode Completed when the resume point is within 2 minutes of the end', () => {
    const episodes: SavedEpisode[] = [
      createMockSavedEpisode({
        id: 'nearend1',
        duration_ms: 600000, // 10 minutes
        resume_position_ms: 528000, // 88%, 72s remaining
        fully_played: false,
      }),
    ]

    const result = transformToSyncItems(episodes)

    expect(result[0].status).toBe('Completed')
  })

  it('captures episode art and duration for feed cards (#167)', () => {
    const episodes: SavedEpisode[] = [
      createMockSavedEpisode({
        id: 'art1',
        duration_ms: 1830000, // 30m30s
        images: [
          { url: 'https://i.scdn.co/image/large.jpg', height: 640, width: 640 },
          { url: 'https://i.scdn.co/image/small.jpg', height: 64, width: 64 },
        ],
      }),
    ]

    const result = transformToSyncItems(episodes)

    expect(result[0].imageUrl).toBe('https://i.scdn.co/image/large.jpg') // largest-first
    expect(result[0].durationSeconds).toBe(1830)
  })

  it('leaves imageUrl null when the episode has no images', () => {
    const result = transformToSyncItems([createMockSavedEpisode({ id: 'noimg' })])
    expect(result[0].imageUrl).toBeNull()
  })

  it('should include episodes with no progress (empty status)', () => {
    const episodes: SavedEpisode[] = [
      createMockSavedEpisode({
        id: 'no-progress',
        resume_position_ms: 0,
        fully_played: false,
      }),
      createMockSavedEpisode({
        id: 'has-progress',
        duration_ms: 3600000, // 1 hour
        resume_position_ms: 1800000, // 30 minutes = 50%
        fully_played: false,
      }),
    ]

    const result = transformToSyncItems(episodes)

    expect(result).toHaveLength(2)
    expect(result[0].externalId).toBe('spotify:episode:no-progress')
    expect(result[0].status).toBeUndefined() // Empty status maps to undefined
    expect(result[0].progress).toBeUndefined() // No progress when status is empty
    expect(result[1].externalId).toBe('spotify:episode:has-progress')
    expect(result[1].status).toBe('In Progress')
    expect(result[1].progress).toBe('50')
  })

  it('should handle episodes with undefined resume_point', () => {
    const episode = createMockSavedEpisode({
      id: 'never-played',
    })
    // Simulate missing resume_point (can happen with some Spotify responses)
    ;(episode.episode as unknown as { resume_point: undefined }).resume_point = undefined

    const result = transformToSyncItems([episode])

    expect(result).toHaveLength(1)
    expect(result[0].status).toBeUndefined() // Empty status
    expect(result[0].progress).toBeUndefined() // No progress when status is empty
  })

  it('should mark completed episodes correctly', () => {
    const episodes: SavedEpisode[] = [
      createMockSavedEpisode({
        duration_ms: 1000000,
        resume_position_ms: 980000, // 98%
        fully_played: false,
      }),
    ]

    const result = transformToSyncItems(episodes)

    expect(result[0].status).toBe('Completed')
    expect(result[0].progress).toBe('98')
  })

  it('should mark fully_played episodes as completed', () => {
    const episodes: SavedEpisode[] = [
      createMockSavedEpisode({
        duration_ms: 1000000,
        resume_position_ms: 500000, // Only 50% but fully_played=true
        fully_played: true,
      }),
    ]

    const result = transformToSyncItems(episodes)

    expect(result[0].status).toBe('Completed')
  })

  it('should handle empty array', () => {
    expect(transformToSyncItems([])).toEqual([])
  })

  it('should handle multiple episodes', () => {
    const episodes: SavedEpisode[] = [
      createMockSavedEpisode({ id: '1', duration_ms: 1000000, resume_position_ms: 100000 }), // 10%
      createMockSavedEpisode({ id: '2', duration_ms: 1000000, resume_position_ms: 500000 }), // 50%
      createMockSavedEpisode({ id: '3', duration_ms: 1000000, resume_position_ms: 900000 }), // 90%
    ]

    const result = transformToSyncItems(episodes)

    expect(result).toHaveLength(3)
    expect(result.map((r) => r.externalId)).toEqual([
      'spotify:episode:1',
      'spotify:episode:2',
      'spotify:episode:3',
    ])
  })
})

// Helper to create mock SavedEpisode objects
function createMockSavedEpisode(overrides: {
  id?: string
  name?: string
  show_name?: string
  duration_ms?: number
  resume_position_ms?: number
  fully_played?: boolean
  release_date?: string
  images?: { url: string; height?: number; width?: number }[]
}): SavedEpisode {
  const id = overrides.id ?? 'test-episode-id'
  return {
    added_at: '2024-01-01T00:00:00Z',
    episode: {
      id,
      name: overrides.name ?? 'Test Episode',
      duration_ms: overrides.duration_ms ?? 3600000,
      release_date: overrides.release_date ?? '2024-01-15',
      show: {
        id: 'test-show-id',
        name: overrides.show_name ?? 'Test Show',
      },
      external_urls: {
        spotify: `https://open.spotify.com/episode/${id}`,
      },
      ...(overrides.images && { images: overrides.images }),
      resume_point: {
        fully_played: overrides.fully_played ?? false,
        resume_position_ms: overrides.resume_position_ms ?? 0,
      },
    },
  }
}
