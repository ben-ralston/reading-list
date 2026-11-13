/**
 * Back-catalog guard for the Spotify sync (#305).
 *
 * Following a show can put its whole archive into Spotify saved episodes
 * (This American Life Partners: 200+ episodes back to 1995), and Spotify keeps
 * rotating more of them in over the following days. Without a guard every sync
 * imports another batch into the queue and fires a summary for each.
 *
 * An unplayed episode released well before it was saved is a back-catalog
 * *candidate*. One such save is usually deliberate (a recommended old episode),
 * so a candidate is only skipped when its show has at least
 * BACK_CATALOG_MIN_SHOW_COUNT candidates across the saved list — a dump, not a
 * pick.
 * Skipped episodes are re-evaluated every run; once the user plays one it has
 * progress, stops being a candidate, and is imported normally.
 */

import type { SyncItem } from '@/lib/sync/matching'
import { UNKNOWN_SHOW_NAME } from './transform'

/** Minimum gap between release and save for an episode to count as back catalog. */
export const BACK_CATALOG_MIN_AGE_DAYS = 14
/** Candidates from one show in one run at/above which they are treated as a dump. */
export const BACK_CATALOG_MIN_SHOW_COUNT = 5

const DAY_MS = 86_400_000

export function isBackCatalogCandidate(item: SyncItem): boolean {
  if (item.status) return false // played episodes are always imported
  if (!item.publishedOn || !item.savedAt) return false
  const released = Date.parse(item.publishedOn)
  const saved = Date.parse(item.savedAt)
  if (Number.isNaN(released) || Number.isNaN(saved)) return false
  return saved - released > BACK_CATALOG_MIN_AGE_DAYS * DAY_MS
}

export interface BackCatalogPartition {
  /** Items to create, in their original order. */
  keep: SyncItem[]
  skipped: SyncItem[]
  /** Skipped count per show (SyncItem.author is the normalized show name). */
  skippedByShow: Record<string, number>
}

/**
 * Split creation candidates into those to import and a show's back-catalog dump.
 *
 * `savedItems` is the whole saved list (already-imported episodes included):
 * a show's dump is judged on all of its unplayed old saves, so an archive that
 * trickles in a few episodes per run is still recognised once enough of it has
 * arrived. Defaults to `items`.
 */
export function partitionBackCatalog(
  items: SyncItem[],
  savedItems: SyncItem[] = items
): BackCatalogPartition {
  const candidatesByShow = new Map<string, number>()
  for (const item of savedItems) {
    // Episodes with no show name share the sentinel; pooling them would turn
    // unrelated single saves into a fake dump.
    if (item.author === UNKNOWN_SHOW_NAME || !isBackCatalogCandidate(item)) continue
    candidatesByShow.set(item.author, (candidatesByShow.get(item.author) ?? 0) + 1)
  }

  const keep: SyncItem[] = []
  const skipped: SyncItem[] = []
  const skippedByShow: Record<string, number> = {}
  for (const item of items) {
    const isDump = (candidatesByShow.get(item.author) ?? 0) >= BACK_CATALOG_MIN_SHOW_COUNT
    if (isDump && isBackCatalogCandidate(item)) {
      skipped.push(item)
      skippedByShow[item.author] = (skippedByShow[item.author] ?? 0) + 1
    } else {
      keep.push(item)
    }
  }
  return { keep, skipped, skippedByShow }
}
