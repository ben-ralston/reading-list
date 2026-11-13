import { type QueueItem } from './queue-client'

// Media-type classification for queue items. Extracted from app/home-client.tsx
// (#171) so non-page modules (e.g. components/reading-list.tsx) can use the
// predicate without importing the server page or creating a module cycle.

export type MediaFilter = 'all' | 'audio' | 'text'
export type MediaType = 'audio' | 'text'

// The platform name Askwho Casts episodes are stored under in content_sources (#226).
export const ASKWHOCASTS_PLATFORM = 'Askwho Casts'

// source_label of episodes from Askwho's public "AI Article Readings" show on
// Spotify (#237, #245). Lives here because the card checks it too.
export const AWC_PUBLIC_SHOW_LABEL = 'AI Article Readings'

// source_label of a post's comments episode (#368): a second Askwho Casts source
// beside the article's own. It's a separate listen, so nothing that asks "does
// this post have audio?" counts it.
export const AWC_COMMENTS_LABEL = 'Comments'

export function isAwcCommentsSource(source: { platform: string; sourceLabel?: string | null }): boolean {
  return source.platform === ASKWHOCASTS_PLATFORM && source.sourceLabel === AWC_COMMENTS_LABEL
}

// Platforms whose sources already carry native audio — TTS handoff is redundant
// for these, so the "Listen in ElevenReader" action is hidden when one is present.
export const AUDIO_PLATFORMS = ['Spotify', 'Podcast', 'YouTube', 'Audible', ASKWHOCASTS_PLATFORM]

// Check if an item has any source matching the given media type.
// Items with both audio and text sources will appear in both filters.
export function hasMediaType(item: QueueItem, type: MediaType): boolean {
  if (type === 'audio') {
    return item.sources.some(s => AUDIO_PLATFORMS.includes(s.platform) && !isAwcCommentsSource(s))
  }
  // 'text' is anything that's not an audio platform
  return item.sources.some(s => !AUDIO_PLATFORMS.includes(s.platform))
}

// Get primary media type for display purposes (deprecated but kept for compatibility)
export function getMediaType(item: QueueItem): MediaType {
  const primarySource = item.sources.find(s => s.isPrimary) || item.sources[0]
  return primarySource && AUDIO_PLATFORMS.includes(primarySource.platform) ? 'audio' : 'text'
}
