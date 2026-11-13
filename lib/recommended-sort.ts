// "Recommended" sort (#255): scores queue items from client-visible signals
// and orders them with an author-diversity pass. Pure module — no supabase,
// no Date.now() outside the recommendedSort default, deterministic given a
// fixed clock.

import { isStartedStatus } from './content-status'
import type { QueueItem } from './queue-client'
import { authorKey } from './author-filter'
import { parseProgress } from './transform-utils'

export const RECENCY_HALF_LIFE_DAYS = 14
// Score multiplier applied per prior pick of the same diversity key.
export const DIVERSITY_DAMPING = 0.5

// Signal weights (each signal is normalized to 0..1). In-progress is dominant
// at the scoring stage: a non-in-progress item maxes out at the sum of the
// other weights (0.55). Note this dominance is a property of the BASE score
// only — the diversity pass below dampens whole scores, in-progress included,
// so a third item by an already-picked author can fall below fresher material
// by another author. That trade is deliberate: spread beats streaks.
export const WEIGHTS = {
  inProgress: 0.45,
  recency: 0.2,
  engagement: 0.15,
  intent: 0.12,
  reader: 0.08,
} as const

const MS_PER_DAY = 86_400_000

// 0..1: 0 for not-started; in-progress items score 0.6..1.0, deeper progress
// higher ("finish what you started"). Unparseable progress → midpoint shape.
function inProgressSignal(item: QueueItem): number {
  if (!isStartedStatus(item.status)) return 0
  const percent = parseProgress(item.progress)
  return percent === undefined ? 0.8 : 0.6 + 0.4 * (percent / 100)
}

// 0..1 exponential decay with a 14-day half-life on publishedOn || createdAt.
// Unparseable dates read as ancient (0); future dates clamp to 1.
function recencySignal(item: QueueItem, nowMs: number): number {
  const parsed = Date.parse(item.publishedOn || item.createdAt)
  if (Number.isNaN(parsed)) return 0
  const ageDays = Math.max(0, (nowMs - parsed) / MS_PER_DAY)
  return 2 ** (-ageDays / RECENCY_HALF_LIFE_DAYS)
}

// 0..1: author engagement (view range -1..1) mapped linearly; missing → neutral.
function engagementSignal(item: QueueItem): number {
  const score = item.engagementScore
  if (score === null || score === undefined) return 0.5
  return (score + 1) / 2
}

// 0..1: explicit user intent. Confirmed positions count double an AI-suggested
// one; both decay with position depth. Value-based on purpose — duplicate
// position-1 rows (#229) all get full credit, none are dropped.
function intentSignal(item: QueueItem): number {
  if (item.queuePosition === null || item.queuePosition < 1) return 0
  return (item.positionConfirmed ? 1 : 0.5) / item.queuePosition
}

export interface ScoreOptions {
  // false drops the queue-position intent signal. The home shortlist's
  // fallback (#377) uses this: the feed no longer reads legacy positions.
  intent?: boolean
}

export function recommendedScore(item: QueueItem, nowMs: number, opts?: ScoreOptions): number {
  const intent = opts?.intent === false ? 0 : intentSignal(item)
  return (
    WEIGHTS.inProgress * inProgressSignal(item) +
    WEIGHTS.recency * recencySignal(item, nowMs) +
    WEIGHTS.engagement * engagementSignal(item) +
    WEIGHTS.intent * intent +
    WEIGHTS.reader * (item.sentToReaderAt != null ? 1 : 0)
  )
}

// Diversity key: normalized author; unknown authors group by their primary
// source's label (e.g. Spotify show name) so episodes of one show still
// spread, and items with neither get a unique key (no cross-dampening).
export function diversityKey(item: QueueItem): string {
  const key = authorKey(item.author)
  if (key !== '') return `author:${key}`
  const primary = item.sources.find(s => s.isPrimary) || item.sources[0]
  const label = primary?.sourceLabel?.trim().toLowerCase()
  if (label) return `label:${label}`
  return `item:${item.id}`
}

interface Candidate {
  item: QueueItem
  base: number
  key: string
  tieDate: number
  picked: boolean
}

// Greedy MMR-style ordering: repeatedly pick the highest effective score,
// where effective = base * DIVERSITY_DAMPING^(picks of that key so far).
// Ties break by newer date then lower id, so the result is deterministic.
// Returns a new array; never mutates the input (rollback snapshots depend
// on that — unlike the in-place sorts in parseQueueData's other branches).
export function recommendedSort(items: QueueItem[], opts?: { now?: number } & ScoreOptions): QueueItem[] {
  if (items.length === 0) return []
  const now = opts?.now ?? Date.now()

  const candidates: Candidate[] = items.map(item => ({
    item,
    base: recommendedScore(item, now, opts),
    key: diversityKey(item),
    tieDate: Date.parse(item.publishedOn || item.createdAt) || 0,
    picked: false,
  }))

  const pickCounts = new Map<string, number>()
  const result: QueueItem[] = []

  for (let slot = 0; slot < candidates.length; slot++) {
    let best: Candidate | null = null
    let bestScore = -1
    for (const candidate of candidates) {
      if (candidate.picked) continue
      const damping = DIVERSITY_DAMPING ** (pickCounts.get(candidate.key) ?? 0)
      const effective = candidate.base * damping
      if (
        best === null ||
        effective > bestScore ||
        (effective === bestScore &&
          (candidate.tieDate > best.tieDate ||
            (candidate.tieDate === best.tieDate && candidate.item.id < best.item.id)))
      ) {
        best = candidate
        bestScore = effective
      }
    }
    // best is always set: at least one unpicked candidate remains per iteration
    const chosen = best as Candidate
    chosen.picked = true
    pickCounts.set(chosen.key, (pickCounts.get(chosen.key) ?? 0) + 1)
    result.push(chosen.item)
  }

  return result
}
