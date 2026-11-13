/**
 * Audible ↔ Goodreads book deduplication planner (#42).
 *
 * The /api/sync merge matches on normalized title. Audible reports *base* titles
 * ("Manufacturing Consent") while Goodreads stores *full* titles with a
 * ": subtitle" or " (Series, #N)" suffix, so a handful of books were created
 * twice before the base-title matcher (lib/sync/matching.ts, Strategy 3.5)
 * landed. This planner finds those existing duplicate pairs and produces a
 * deterministic merge plan:
 *   - always KEEP the Goodreads (full-title) row as canonical,
 *   - attach the Audible source to it as a secondary source,
 *   - reconcile status/queue_position (Audible is authoritative on whether a
 *     book was finished),
 *   - DROP the orphan Audible row.
 *
 * Pure, book-scoped, and conservative: it only auto-merges an unambiguous
 * one-Goodreads + one-Audible pair. Anything more complex (Goodreads-only dup,
 * multiple Audible rows, an already-merged row in the group) is reported as
 * `skipped` for manual review rather than auto-merged. The DB-touching runner
 * lives in scripts/audible-dedup.ts.
 */
import { normalizeTitle, baseTitle } from '@/lib/sync/normalize-title'

export interface DedupSource {
  id: number
  platform: string
  external_id: string | null
  link: string | null
  is_primary: boolean
}

export interface DedupItem {
  id: number
  title: string
  author: string
  kind: string
  status: string
  queue_position: number | null
  position_confirmed: boolean
  progress: string | null
  sources: DedupSource[]
}

export interface AudibleMergePlan {
  baseKey: string
  author: string
  keepId: number
  keepTitle: string
  dropId: number
  dropTitle: string
  /** Source rows to re-point from the dropped item onto the keeper. */
  movedSourceIds: number[]
  /** New keeper status, or null to leave it unchanged. */
  newStatus: string | null
  /** Whether to NULL the keeper's queue_position (status became Completed/Skip). */
  clearPosition: boolean
  /** New keeper progress, or null to leave it unchanged. */
  newProgress: string | null
}

export interface SkippedGroup {
  baseKey: string
  author: string
  reason: string
  itemIds: number[]
}

export interface DedupPlan {
  merges: AudibleMergePlan[]
  skipped: SkippedGroup[]
}

// A more-advanced status wins when reconciling a merged pair.
const STATUS_RANK: Record<string, number> = { Completed: 4, 'In Progress': 3, Skip: 2, '': 1 }

function rank(status: string): number {
  return STATUS_RANK[status] ?? 0
}

/** Collapse internal whitespace so Goodreads CSV "John  Green" pairs with Audible "John Green". */
function normAuthor(author: string): string {
  return author.trim().toLowerCase().replace(/\s+/g, ' ')
}

function isAudibleSource(s: DedupSource): boolean {
  return (s.external_id ?? '').startsWith('audible:')
}

/**
 * Build a deterministic merge plan for Audible↔Goodreads book duplicates.
 *
 * @param items - All content items (with embedded sources). Non-book kinds are ignored.
 */
export function planAudibleDedup(items: DedupItem[]): DedupPlan {
  // Group books by (whitespace-collapsed author | base title).
  const groups = new Map<string, DedupItem[]>()
  for (const it of items) {
    if (it.kind !== 'book') continue
    const base = baseTitle(normalizeTitle(it.title, it.author))
    if (base === '') continue
    const key = `${normAuthor(it.author)}|${base}`
    const group = groups.get(key) ?? []
    group.push(it)
    groups.set(key, group)
  }

  const merges: AudibleMergePlan[] = []
  const skipped: SkippedGroup[] = []

  for (const [key, group] of groups) {
    if (group.length < 2) continue

    const audibleOnly = group.filter(
      (i) => i.sources.length > 0 && i.sources.every(isAudibleSource)
    )
    const nonAudible = group.filter((i) => !i.sources.some(isAudibleSource))
    const alreadyMerged = group.filter(
      (i) => i.sources.some(isAudibleSource) && i.sources.some((s) => !isAudibleSource(s))
    )

    const author = group[0].author
    const itemIds = group.map((i) => i.id).sort((a, b) => a - b)

    // Only a clean one-Goodreads + one-Audible pair is auto-merged; everything
    // else is surfaced for a human to look at.
    if (audibleOnly.length === 1 && nonAudible.length === 1 && alreadyMerged.length === 0) {
      const keep = nonAudible[0]
      const drop = audibleOnly[0]

      const resolvedStatus = rank(drop.status) > rank(keep.status) ? drop.status : keep.status
      const newStatus = resolvedStatus !== keep.status ? resolvedStatus : null
      const clearPosition =
        (resolvedStatus === 'Completed' || resolvedStatus === 'Skip') && keep.queue_position !== null

      // Only carry progress over for a book that ends up actively In Progress —
      // a Completed Audible row reports a misleading ~99% that shouldn't show.
      const keepProg = parseInt(keep.progress ?? '', 10)
      const dropProg = parseInt(drop.progress ?? '', 10)
      const newProgress =
        resolvedStatus === 'In Progress' && !isNaN(dropProg) && (isNaN(keepProg) || dropProg > keepProg)
          ? drop.progress
          : null

      merges.push({
        baseKey: key,
        author,
        keepId: keep.id,
        keepTitle: keep.title,
        dropId: drop.id,
        dropTitle: drop.title,
        movedSourceIds: drop.sources.map((s) => s.id),
        newStatus,
        clearPosition,
        newProgress,
      })
    } else {
      skipped.push({
        baseKey: key,
        author,
        reason: `${nonAudible.length} non-Audible, ${audibleOnly.length} Audible-only, ${alreadyMerged.length} already-merged`,
        itemIds,
      })
    }
  }

  return { merges, skipped }
}
