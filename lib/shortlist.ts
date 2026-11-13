// The home shortlist (#377): what the feed home screen shows, in order.
//
//   1. items the owner pinned ("Make next"), newest pin first;
//   2. the latest succeeded queue-curator run's picks, in rank order, minus
//      anything no longer active, already pinned, or dismissed ("Not now")
//      within the hold;
//   3. if that leaves fewer than HOME_SIZE, the Recommended formula over the
//      rest of the pile, without its legacy queue-position signal.
//
// Pure and client-safe: HomeClient calls buildShortlist during render on the
// server and in the browser, so first paint, hydration and every optimistic
// update share one ordering. queue-curator imports DISMISS_HOLD_DAYS from
// here so the app and the curator agree on the hold.

import type { QueueItem } from './queue-client'
import { recommendedSort } from './recommended-sort'

export const HOME_SIZE = 8
export const DISMISS_HOLD_DAYS = 21
export const STALE_AFTER_HOURS = 24
export const MAX_REASON_CHARS = 60
export const MAX_PICKS = 25

const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000

export interface CurationPick {
  id: number
  reason: string | null
}

export interface Curation {
  finishedAt: string
  picks: CurationPick[]
}

export type ShortlistTier = 'pinned' | 'pick' | 'fallback'

export interface ShortlistEntry {
  item: QueueItem
  tier: ShortlistTier
  // Claude's one-line reason; only picks carry one.
  reason: string | null
}

function cleanReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (text === '' || text.length > MAX_REASON_CHARS || /[\r\n]/.test(text)) return null
  return text
}

// curation_runs.picks is JSONB with no foreign key; validate it at the read.
export function parseCurationPicks(raw: unknown): CurationPick[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<number>()
  const picks: CurationPick[] = []
  for (const entry of raw) {
    if (picks.length >= MAX_PICKS) break
    if (!entry || typeof entry !== 'object') continue
    const { id, reason } = entry as { id?: unknown; reason?: unknown }
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0 || seen.has(id)) continue
    seen.add(id)
    picks.push({ id, reason: cleanReason(reason) })
  }
  return picks
}

// A timestamp a little ahead of this clock (another device's write) still
// counts as within the hold.
export function isDismissedWithinHold(dismissedAt: string | null | undefined, nowMs: number): boolean {
  if (!dismissedAt) return false
  const at = Date.parse(dismissedAt)
  if (Number.isNaN(at)) return false
  return nowMs - at < DISMISS_HOLD_DAYS * MS_PER_DAY
}

function isActive(item: QueueItem): boolean {
  return item.status !== 'Completed' && item.status !== 'Skip'
}

export function buildShortlist(
  items: QueueItem[],
  curation: Curation | null,
  nowMs: number,
  size: number = HOME_SIZE,
): ShortlistEntry[] {
  const active = items.filter(isActive)
  const taken = new Set<number>()
  const entries: ShortlistEntry[] = []
  const add = (item: QueueItem, tier: ShortlistTier, reason: string | null) => {
    taken.add(item.id)
    entries.push({ item, tier, reason })
  }

  const pinned = active
    .filter(item => item.pinnedAt)
    .sort((a, b) => (Date.parse(b.pinnedAt!) || 0) - (Date.parse(a.pinnedAt!) || 0) || b.id - a.id)
  for (const item of pinned) add(item, 'pinned', null)

  const byId = new Map(active.map(item => [item.id, item]))
  for (const pick of curation?.picks ?? []) {
    if (entries.length >= size) break
    const item = byId.get(pick.id)
    if (!item || taken.has(item.id) || isDismissedWithinHold(item.shortlistDismissedAt, nowMs)) continue
    add(item, 'pick', pick.reason)
  }

  if (entries.length < size) {
    const rest = active.filter(
      item => !taken.has(item.id) && !isDismissedWithinHold(item.shortlistDismissedAt, nowMs),
    )
    for (const item of recommendedSort(rest, { now: nowMs, intent: false })) {
      if (entries.length >= size) break
      add(item, 'fallback', null)
    }
  }

  return entries.slice(0, size)
}

export function curationFreshness(
  curation: Curation | null,
  nowMs: number,
): { label: string; stale: boolean } {
  if (!curation) return { label: 'No picks from Claude yet', stale: true }
  const finished = Date.parse(curation.finishedAt)
  if (Number.isNaN(finished)) return { label: 'No picks from Claude yet', stale: true }
  const age = Math.max(0, nowMs - finished)
  const stale = age > STALE_AFTER_HOURS * MS_PER_HOUR
  let ago: string
  if (age < MS_PER_MINUTE) ago = 'just now'
  else if (age < MS_PER_HOUR) ago = `${Math.floor(age / MS_PER_MINUTE)}m ago`
  else if (age < 48 * MS_PER_HOUR) ago = `${Math.floor(age / MS_PER_HOUR)}h ago`
  else ago = `${Math.floor(age / MS_PER_DAY)} days ago`
  return { label: `Picks updated ${ago}`, stale }
}

// The Everything page's NEW badge (#377): added after the previous visit.
// Nothing is new before the first recorded visit.
export function isNewSince(item: QueueItem, lastSeen: string | null): boolean {
  if (!lastSeen) return false
  const since = Date.parse(lastSeen)
  const added = Date.parse(item.createdAt)
  return !Number.isNaN(since) && !Number.isNaN(added) && added > since
}
