// Who can be converted with Askwho Casts (#364). Shared by the menu and the
// API route, so the server accepts exactly what the card offers. Separate from
// canListenInReader: ElevenReader is pointless on audio, but Convert exists to
// replace weak audio.
import type { ContentSource, QueueItem } from '@/lib/queue-client'
import { commentsLink } from '@/lib/comments-link'
import { ASKWHOCASTS_PLATFORM, AUDIO_PLATFORMS, AWC_PUBLIC_SHOW_LABEL, isAwcCommentsSource } from '@/lib/media-type'
import { effectivePrimarySource } from '@/lib/transform-utils'

// The readable article to submit, or null when there isn't one. Never an audio
// source: item.link can be a Spotify URL when Spotify is primary.
export function articleSource(item: Pick<QueueItem, 'sources'>): ContentSource | null {
  const articles = item.sources.filter(
    (s) => !AUDIO_PLATFORMS.includes(s.platform) && /^https?:\/\//.test(s.link ?? ''),
  )
  return articles.find((s) => s.isPrimary) ?? effectivePrimarySource(articles, null)
}

// A private-feed episode of the article, or a copy from Askwho's public show on
// Spotify. A comments episode doesn't count: the article can still be converted.
export function hasAwcAudio(item: Pick<QueueItem, 'sources'>): boolean {
  return item.sources.some(
    (s) => (s.platform === ASKWHOCASTS_PLATFORM && !isAwcCommentsSource(s)) || (s.platform === 'Spotify' && s.sourceLabel === AWC_PUBLIC_SHOW_LABEL),
  )
}

export function hasAwcCommentsAudio(item: Pick<QueueItem, 'sources'>): boolean {
  return item.sources.some(isAwcCommentsSource)
}

// No re-convert: syncEpisode's markDoneForItem would close the new row as soon
// as the feed lists the old episode, and ensureRssSource keeps one row per
// (item, platform).
export function canConvertWithAwc(item: Pick<QueueItem, 'sources'>, isBooks: boolean): boolean {
  return !isBooks && !hasAwcAudio(item) && articleSource(item) !== null
}

// #368: any LessWrong post, once per post, whether or not the article has audio.
// Whether it has enough comments is only known at run time, and that check stops
// before the agent starts or any credits are spent.
export function canConvertCommentsWithAwc(item: Pick<QueueItem, 'sources'>, isBooks: boolean): boolean {
  return !isBooks && !hasAwcCommentsAudio(item) && commentsLink(item.sources) !== null
}
