/** Parsing strategy for a feed. */
export type FeedType = 'substack' | 'lesswrong' | 'generic'

/**
 * Infer the parsing strategy from a feed URL's host.
 * Unknown / unparseable hosts fall back to 'generic'.
 */
export function detectFeedType(url: string): FeedType {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return 'generic'
  }
  if (host === 'substack.com' || host.endsWith('.substack.com')) return 'substack'
  if (host === 'lesswrong.com' || host === 'www.lesswrong.com') return 'lesswrong'
  // LessWrong's "Curated & Popular" feed is hosted on Buzzsprout (podcast host); treat it as lesswrong.
  if (host === 'feeds.buzzsprout.com') return 'lesswrong'
  return 'generic'
}
