import { describe, it, expect } from 'vitest'
import {
  episodeIdFromExternalId,
  computeResumeSeconds,
  formatResumeTimestamp,
  buildSpotifyResumeUrl,
  getSpotifyResume,
} from './resume-link'
import type { ContentSource, QueueItem } from '@/lib/queue-client'

function src(
  platform: string,
  externalId: string | null = null,
  progress: number | null = null
): ContentSource {
  return {
    id: 1,
    platform,
    link: 'https://example.com',
    messageId: null,
    isPrimary: true,
    createdAt: 'c',
    externalId,
    progress,
    sourceLabel: null,
  }
}

// Eligible baseline: dual-source with the read position (Substack 45) well
// ahead of Spotify's own last-seen position (10). Item-level progress is set
// HIGHER on purpose — the gate must ignore it (#194 disagreement gate).
function itemWith(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    sources: [src('Substack', null, 45), src('Spotify', 'spotify:episode:abc123', 10)],
    progress: '90',
    durationSeconds: 3600,
    status: 'In Progress',
    ...overrides,
  } as QueueItem
}

describe('episodeIdFromExternalId', () => {
  it('extracts the id from a spotify:episode external id', () => {
    expect(episodeIdFromExternalId('spotify:episode:abc123')).toBe('abc123')
  })

  it.each([null, undefined, '', 'audible:xyz', 'spotify:episode:'])(
    'returns null for %j',
    (externalId) => {
      expect(episodeIdFromExternalId(externalId)).toBeNull()
    }
  )
})

describe('computeResumeSeconds', () => {
  it('maps a progress percent onto the episode duration', () => {
    expect(computeResumeSeconds(45, 3600)).toBe(1620)
  })

  it('rounds to whole seconds', () => {
    expect(computeResumeSeconds(33, 100)).toBe(33)
    expect(computeResumeSeconds(1, 90)).toBe(1) // 0.9 → 1
  })

  it('clamps to the duration', () => {
    expect(computeResumeSeconds(200, 100)).toBe(100)
    expect(computeResumeSeconds(-5, 100)).toBe(0)
  })
})

describe('formatResumeTimestamp', () => {
  it('formats minutes and seconds', () => {
    expect(formatResumeTimestamp(1620)).toBe('~27:00')
    expect(formatResumeTimestamp(65)).toBe('~1:05')
  })

  it('formats hours for long episodes', () => {
    expect(formatResumeTimestamp(3661)).toBe('~1:01:01')
  })

  it('formats zero', () => {
    expect(formatResumeTimestamp(0)).toBe('~0:00')
  })
})

describe('buildSpotifyResumeUrl', () => {
  it('builds the open.spotify.com URL with the t param', () => {
    expect(buildSpotifyResumeUrl('abc123', 1620)).toBe(
      'https://open.spotify.com/episode/abc123?t=1620'
    )
  })
})

describe('getSpotifyResume', () => {
  it('returns url, label and seconds when the read position is ahead of Spotify', () => {
    const resume = getSpotifyResume(itemWith())
    expect(resume).toEqual({
      url: 'https://open.spotify.com/episode/abc123?t=1620',
      label: '~27:00',
      seconds: 1620,
    })
  })

  it('seeks to the READ position, not the item high-water mark', () => {
    // itemWith sets item.progress '90'; the Substack source says 45 → t must
    // be 45% of 3600, not 90%.
    expect(getSpotifyResume(itemWith())!.seconds).toBe(1620)
  })

  it('is hidden when Spotify is within the margin of the read position', () => {
    const item = itemWith({
      sources: [src('Substack', null, 45), src('Spotify', 'spotify:episode:abc123', 41)],
    })
    expect(getSpotifyResume(item)).toBeNull() // 45 < 41 + 5
  })

  it('shows exactly at the margin boundary', () => {
    const item = itemWith({
      sources: [src('Substack', null, 45), src('Spotify', 'spotify:episode:abc123', 40)],
    })
    expect(getSpotifyResume(item)).not.toBeNull() // 45 >= 40 + 5
  })

  it('is hidden when Spotify is at or ahead of the read position', () => {
    const item = itemWith({
      sources: [src('Substack', null, 45), src('Spotify', 'spotify:episode:abc123', 60)],
    })
    expect(getSpotifyResume(item)).toBeNull()
  })

  it('treats an unreported Spotify position as 0', () => {
    const shown = itemWith({
      sources: [src('Substack', null, 5), src('Spotify', 'spotify:episode:abc123', null)],
    })
    expect(getSpotifyResume(shown)!.seconds).toBe(180) // 5% of 3600

    const hidden = itemWith({
      sources: [src('Substack', null, 4), src('Spotify', 'spotify:episode:abc123', null)],
    })
    expect(getSpotifyResume(hidden)).toBeNull() // 4 < 0 + 5
  })

  it('is hidden without a harvested read position, even with item-level progress', () => {
    const item = itemWith({
      sources: [src('Substack', null, null), src('Spotify', 'spotify:episode:abc123', 10)],
      progress: '90',
    })
    expect(getSpotifyResume(item)).toBeNull()
  })

  it('ignores progress on audio-platform sources when finding the read position', () => {
    const item = itemWith({
      sources: [
        src('Substack', null, null),
        src('YouTube', null, 80),
        src('Spotify', 'spotify:episode:abc123', 10),
      ],
    })
    expect(getSpotifyResume(item)).toBeNull()
  })

  it('uses the furthest text-source position when several exist', () => {
    const item = itemWith({
      sources: [
        src('Substack', null, 20),
        src('LessWrong', null, 50),
        src('Spotify', 'spotify:episode:abc123', 10),
      ],
    })
    expect(getSpotifyResume(item)!.seconds).toBe(1800) // 50% of 3600
  })

  it('is null for a Spotify-only item (Spotify resumes natively)', () => {
    const item = itemWith({ sources: [src('Spotify', 'spotify:episode:abc123', 50)] })
    expect(getSpotifyResume(item)).toBeNull()
  })

  it('targets the listened episode when the item has multiple Spotify episode rows (#237)', () => {
    // Public-show row never played (null); private-feed row is where the user
    // actually listens — the resume link must deep-link THAT episode.
    const item = itemWith({
      sources: [
        src('Substack', null, 45),
        { ...src('Spotify', 'spotify:episode:public1', null), isPrimary: false },
        { ...src('Spotify', 'spotify:episode:priv99', 10), isPrimary: false },
      ],
    })
    expect(getSpotifyResume(item)!.url).toBe('https://open.spotify.com/episode/priv99?t=1620')
  })

  it('gates against the listened episode row, not an idle sibling row (#237)', () => {
    // Listened row is at 43 → 45 < 43 + 5 → hidden. The idle row's unreported
    // position must not be used to force the action visible.
    const item = itemWith({
      sources: [
        src('Substack', null, 45),
        { ...src('Spotify', 'spotify:episode:priv99', 43), isPrimary: false },
        { ...src('Spotify', 'spotify:episode:public1', null), isPrimary: false },
      ],
    })
    expect(getSpotifyResume(item)).toBeNull()
  })

  it('is null without a spotify:episode external id', () => {
    const item = itemWith({
      sources: [src('Substack', null, 45), src('Spotify', null, 10)],
    })
    expect(getSpotifyResume(item)).toBeNull()
  })

  it('is null when the duration is unknown or zero', () => {
    expect(getSpotifyResume(itemWith({ durationSeconds: null }))).toBeNull()
    expect(getSpotifyResume(itemWith({ durationSeconds: 0 }))).toBeNull()
  })

  it('is null for archived statuses', () => {
    expect(getSpotifyResume(itemWith({ status: 'Completed' }))).toBeNull()
    expect(getSpotifyResume(itemWith({ status: 'Skip' }))).toBeNull()
  })

  it('allows the empty (queued) status', () => {
    expect(getSpotifyResume(itemWith({ status: '' }))).not.toBeNull()
  })
})
