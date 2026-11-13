import type { ContentSource } from './queue-client'

/** Select the article source, never the primary Spotify/audio link. */
export function commentsLink(sources: ContentSource[]): string | null {
  for (const source of sources) {
    if (source.platform !== 'LessWrong' || !source.link) continue
    try {
      const url = new URL(source.link)
      if (!['http:', 'https:'].includes(url.protocol)) continue
      if (!['lesswrong.com', 'www.lesswrong.com'].includes(url.hostname)) continue
      if (!url.pathname.startsWith('/posts/')) continue
      url.hash = 'comments'
      return url.toString()
    } catch { /* A malformed source must not hide the reminder or Done action. */ }
  }
  return null
}
