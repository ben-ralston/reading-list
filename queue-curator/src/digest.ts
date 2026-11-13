// Turns raw rows into what the curator shows Claude: one compact candidate
// per active feed item, and a digest of what the owner finished and skipped.
// Pure: no database, no clock except the nowMs argument.
import { AUDIO_PLATFORMS, isAwcCommentsSource } from '../../lib/media-type'
import { parseProgress } from '../../lib/transform-utils'

export interface ItemRow {
  id: number
  title: string
  author: string | null
  status: string
  progress: string | null
  published_on: string | null
  created_at: string
  status_changed_at: string | null
  added_by: string | null
  duration_seconds: number | null
  word_count: number | null
  summary: string | null
  // v2 summary JSON ({one_liner, bullets, …}) or anything older; only bullets are read.
  summary_data?: unknown
  // Present once the curation migration is applied (20261109000000).
  pinned_at?: string | null
  shortlist_dismissed_at?: string | null
  sources: { platform: string; source_label: string | null; link?: string | null }[]
}

export interface Candidate {
  id: number
  title: string
  author: string
  labels: string[]
  hasAudio: boolean
  minutes: number | null
  publishedOn: string | null
  addedOn: string
  addedBy: string | null
  status: string
  progressPct: number | null
  // Approximate: progress syncs can move status_changed_at, or advance
  // progress without moving it. Not a last-played time.
  statusChangedOn: string | null
  summary: string | null
  // For the tool-enabled mode: where to read the piece, and the longer summary.
  links: string[]
  bullets: string[]
  // The owner's own overrides: pinned = he put it at the top himself; dismissedOn =
  // the day he moved it off the shortlist (only shown once the hold is over).
  pinned: boolean
  dismissedOn: string | null
}

export interface HistoryRow {
  title: string
  author: string | null
  status: 'Completed' | 'Skip'
  status_changed_at: string | null
}

export interface AuthorHistory {
  author: string
  completed: number
  skipped: number
  completed90d: number
  skipped90d: number
}

export interface History {
  authors: AuthorHistory[]
  recentCompleted: { title: string; author: string }[]
  recentSkipped: { title: string; author: string }[]
}

const READING_WORDS_PER_MINUTE = 230
const MAX_AUTHORS = 80
const MAX_RECENT_COMPLETED = 60
const MAX_RECENT_SKIPPED = 40
const RECENT_WINDOW_MS = 90 * 86_400_000

const day = (iso: string | null): string | null => (iso ? iso.slice(0, 10) : null)

function minutesOf(row: ItemRow): number | null {
  if (row.duration_seconds && row.duration_seconds > 0) return Math.max(1, Math.round(row.duration_seconds / 60))
  if (row.word_count && row.word_count > 0) return Math.max(1, Math.round(row.word_count / READING_WORDS_PER_MINUTE))
  return null
}

function bulletsOf(summaryData: unknown): string[] {
  const bullets = summaryData && typeof summaryData === 'object' ? (summaryData as { bullets?: unknown }).bullets : null
  return Array.isArray(bullets) ? bullets.filter((b): b is string => typeof b === 'string' && b.trim() !== '') : []
}

export function toCandidate(row: ItemRow): Candidate {
  // Sorted: PostgREST returns embedded sources in no fixed order, and an
  // order flip would change the input hash and force a needless run.
  const labels = [...new Set(row.sources.map((s) => s.source_label?.trim() ?? '').filter(Boolean))].sort()
  const hasAudio = row.sources.some(
    (s) => AUDIO_PLATFORMS.includes(s.platform) && !isAwcCommentsSource({ platform: s.platform, sourceLabel: s.source_label }),
  )
  return {
    id: row.id,
    title: row.title,
    author: row.author?.trim() ?? '',
    labels,
    hasAudio,
    minutes: minutesOf(row),
    publishedOn: day(row.published_on),
    addedOn: row.created_at.slice(0, 10),
    addedBy: row.added_by?.trim() || null,
    status: row.status,
    progressPct: parseProgress(row.progress) ?? null,
    statusChangedOn: day(row.status_changed_at),
    summary: row.summary?.trim() || null,
    links: [...new Set(row.sources.map((s) => s.link?.trim() ?? '').filter(Boolean))].sort(),
    bullets: bulletsOf(row.summary_data),
    pinned: Boolean(row.pinned_at),
    dismissedOn: day(row.shortlist_dismissed_at ?? null),
  }
}

export function buildHistory(rows: HistoryRow[], nowMs: number): History {
  const byAuthor = new Map<string, AuthorHistory>()
  const dated: { title: string; author: string; status: HistoryRow['status']; at: number }[] = []

  for (const row of rows) {
    const author = row.author?.trim() ?? ''
    const at = row.status_changed_at ? Date.parse(row.status_changed_at) : Number.NaN
    const recent = !Number.isNaN(at) && nowMs - at <= RECENT_WINDOW_MS
    if (!Number.isNaN(at)) dated.push({ title: row.title, author, status: row.status, at })
    if (author === '') continue
    const entry = byAuthor.get(author) ?? { author, completed: 0, skipped: 0, completed90d: 0, skipped90d: 0 }
    if (row.status === 'Completed') {
      entry.completed++
      if (recent) entry.completed90d++
    } else {
      entry.skipped++
      if (recent) entry.skipped90d++
    }
    byAuthor.set(author, entry)
  }

  const authors = [...byAuthor.values()]
    .sort((a, b) => b.completed + b.skipped - (a.completed + a.skipped) || a.author.localeCompare(b.author))
    .slice(0, MAX_AUTHORS)
  dated.sort((a, b) => b.at - a.at)
  const recent = (status: HistoryRow['status'], max: number) =>
    dated.filter((d) => d.status === status).slice(0, max).map(({ title, author }) => ({ title, author }))

  return {
    authors,
    recentCompleted: recent('Completed', MAX_RECENT_COMPLETED),
    recentSkipped: recent('Skip', MAX_RECENT_SKIPPED),
  }
}
