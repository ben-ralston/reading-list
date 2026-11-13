import type { QueueItem, ContentSource } from './queue-client'
import { ASKWHOCASTS_PLATFORM, isAwcCommentsSource } from './media-type'
import { AWAITING_COMMENTS } from './content-status'

// DisplayItem is now just an alias for QueueItem with progressPercent added
export interface DisplayItem extends QueueItem {
  progressPercent?: number
}

/**
 * Parse progress text to extract numeric percentage
 * Handles formats like: "65% complete", "Progress: 65%", "65"
 */
export function parseProgress(progressText: string | null): number | undefined {
  if (!progressText) return undefined

  const match = progressText.match(/(\d+)/)
  if (!match) return undefined

  const num = Number.parseInt(match[1])
  return num >= 0 && num <= 100 ? num : undefined
}

/**
 * Get primary source from array of ContentSource objects
 * Returns the source marked as isPrimary, or first source as fallback
 */
export function getPrimarySource(sources: ContentSource[]): ContentSource | null {
  if (!sources || sources.length === 0) return null
  return sources.find(s => s.isPrimary) || sources[0]
}

/**
 * Get primary platform name for display
 */
export function getPrimaryPlatform(sources: ContentSource[]): string {
  const primary = getPrimarySource(sources)
  return primary?.platform || 'Web'
}

/**
 * Get primary link URL
 */
export function getPrimaryLink(sources: ContentSource[]): string {
  const primary = getPrimarySource(sources)
  return primary?.link || ''
}

// Priority ordering for non-top queue items (position 2+).
// Text-first: prefer pages with comments/karma/etc. for browsing/triaging.
export const QUEUE_ITEM_PRIORITY = [
  'LessWrong', 'Substack', 'Web', 'YouTube', 'Podcast', ASKWHOCASTS_PLATFORM, 'Spotify', 'Audible',
] as const

/**
 * Compute the effective primary source for an item based on its queue position.
 * - queuePosition === 1: uses isPrimary (today's behavior).
 * - queuePosition 2+ or null: picks the highest-priority match in QUEUE_ITEM_PRIORITY.
 * - If no source matches the priority list, falls back to getPrimarySource.
 */
export function effectivePrimarySource(
  sources: ContentSource[],
  queuePosition: number | null,
): ContentSource | null {
  if (!sources || sources.length === 0) return null
  if (queuePosition === 1) return getPrimarySource(sources)
  for (const platform of QUEUE_ITEM_PRIORITY) {
    const match = sources.find(s => s.platform === platform)
    if (match) return match
  }
  return getPrimarySource(sources)
}

/**
 * What the hero's START opens. The owner converts a post to hear the Askwho Casts
 * episode, so it wins over the primary source, which is usually Spotify (#364).
 * Display only: is_primary is unchanged, and itemLink still uses the primary.
 * Awaiting comments keeps the primary source, as before: the listen is finished,
 * so there's no reason to reopen the episode.
 */
export function heroStartSource(sources: ContentSource[], status?: string | null): ContentSource | null {
  if (status === AWAITING_COMMENTS) return getPrimarySource(sources)
  return sources.find(s => s.platform === ASKWHOCASTS_PLATFORM && s.link && !isAwcCommentsSource(s)) ?? getPrimarySource(sources)
}

// Lower index = higher priority. Unknown platforms sort to the end.
function priorityIndex(platform: string): number {
  const i = (QUEUE_ITEM_PRIORITY as readonly string[]).indexOf(platform)
  return i === -1 ? Number.MAX_SAFE_INTEGER : i
}

/**
 * Return all sources ordered with the effective primary first, then remaining
 * sources sorted by QUEUE_ITEM_PRIORITY (unknown platforms appended last).
 * Used to populate the per-source picker on queue items.
 *
 * Stable: sources sharing the same platform retain their input order, so
 * duplicate-platform sources are never silently dropped.
 */
export function getOrderedSources(
  sources: ContentSource[],
  queuePosition: number | null,
): ContentSource[] {
  if (!sources || sources.length === 0) return []
  const primary = effectivePrimarySource(sources, queuePosition)
  if (!primary) return [...sources]
  const rest = sources.filter(s => s.id !== primary.id)
  rest.sort((a, b) => priorityIndex(a.platform) - priorityIndex(b.platform))
  return [primary, ...rest]
}

/**
 * Platforms this item carries more than once (#245).
 *
 * Since #237 an item can hold several Spotify episode rows, which the source
 * menus would otherwise render as identical "Open on Spotify" entries. Only
 * these platforms get a disambiguating sublabel, so the common single-source
 * case keeps its clean label.
 *
 * Callers must pass the item's FULL source list, not a filtered view — the hero
 * menu excludes the primary source, and computing repeats from that subset would
 * miss the primary-is-Spotify + one-Spotify-alternate case.
 */
export function repeatedPlatforms(sources: ContentSource[]): Set<string> {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const source of sources ?? []) {
    if (seen.has(source.platform)) repeated.add(source.platform)
    else seen.add(source.platform)
  }
  return repeated
}

// Average reading speed for the read-time estimate (#167). Re-tune here.
export const WORDS_PER_MINUTE = 225

/**
 * Format a read/listen/watch length estimate for a feed card (#167).
 * Duration wins over word count (audio/video items). YouTube reads as "watch",
 * other timed sources as "listen", text as "read". Returns null when neither
 * signal is usable so the UI can omit the pill entirely.
 */
export function formatLength(item: {
  wordCount?: number | null
  durationSeconds?: number | null
  platform?: string
}): string | null {
  if (item.durationSeconds != null && item.durationSeconds > 0) {
    const minutes = Math.max(1, Math.round(item.durationSeconds / 60))
    const verb = item.platform === 'YouTube' ? 'watch' : 'listen'
    return `${minutes} min ${verb}`
  }
  if (item.wordCount != null && item.wordCount > 0) {
    const minutes = Math.max(1, Math.round(item.wordCount / WORDS_PER_MINUTE))
    return `${minutes} min read`
  }
  return null
}

/**
 * Transform QueueItem to DisplayItem for UI
 * Adds progressPercent parsed from progress text
 */
export function transformToDisplayItem(item: QueueItem): DisplayItem {
  return {
    ...item,
    progressPercent: parseProgress(item.progress),
  }
}

/**
 * Transform array of QueueItems to DisplayItems
 */
export function transformToDisplayItems(items: QueueItem[]): DisplayItem[] {
  return items.map(transformToDisplayItem)
}
