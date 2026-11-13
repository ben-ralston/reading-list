import type { SyncRun } from '@/lib/sync/sync-logs-repo'
import type { RssFeed } from '@/lib/rss/feeds-repo'

export type SyncState = 'healthy' | 'failing' | 'syncing' | 'degraded' | 'never'

export interface SyncHealth {
  state: SyncState
  lastSuccessAt: string | null
  lastRun: SyncRun | null
}

/** Derive sync health for a source from its recent runs (passed newest-first). */
export function deriveSyncStatus(runs: SyncRun[]): SyncHealth {
  if (runs.length === 0) return { state: 'never', lastSuccessAt: null, lastRun: null }
  const lastRun = runs[0]
  const lastSuccessAt = runs.find((r) => r.status === 'success')?.completedAt ?? null
  const state: SyncState =
    lastRun.status === 'success'
      ? 'healthy'
      : lastRun.status === 'error'
        ? 'failing'
        : lastRun.status === 'partial'
          ? 'degraded'
          : 'syncing'
  return { state, lastSuccessAt, lastRun }
}

export function syncStatusDot(state: SyncState): { color: string; title: string } {
  switch (state) {
    case 'healthy':
      return { color: 'bg-green-500', title: 'Healthy' }
    case 'failing':
      return { color: 'bg-red-500', title: 'Failing' }
    case 'degraded':
      return { color: 'bg-amber-500', title: 'Partial — some items failed' }
    case 'syncing':
      return { color: 'bg-yellow-500', title: 'Syncing…' }
    default:
      return { color: 'bg-gray-300', title: 'Not yet synced' }
  }
}

export type RunTone = 'success' | 'warn' | 'error' | 'pending'

export function formatRun(run: SyncRun): { at: string | null; tone: RunTone; summary: string } {
  const at = run.completedAt ?? run.startedAt
  if (run.status === 'error') return { at, tone: 'error', summary: run.errorMessage ?? 'Failed' }
  if (run.status === 'running') return { at, tone: 'pending', summary: 'Running…' }
  if (run.status === 'partial') {
    // Partial runs record their causes in metadata: per-feed fetch failures in
    // metadata.feedErrors (#132) and lost item writes in metadata.itemErrors
    // (RLV-024). A /api/sync source has no feeds, so item errors must surface on
    // their own — otherwise the card reads the nonsensical "some feeds failed".
    const fe = run.metadata?.feedErrors
    const feedCount = Array.isArray(fe) ? fe.length : 0
    const ie = run.metadata?.itemErrors
    const itemCount = typeof ie === 'number' ? ie : 0
    const parts: string[] = []
    if (feedCount > 0) parts.push(`${feedCount} feed${feedCount === 1 ? '' : 's'} failed`)
    if (itemCount > 0) parts.push(`${itemCount} item${itemCount === 1 ? '' : 's'} failed to persist`)
    const detail = parts.length ? parts.join(', ') : 'some items failed'
    return { at, tone: 'warn', summary: `partial — ${detail}` }
  }
  const parts: string[] = []
  if (run.itemsCreated > 0) parts.push(`${run.itemsCreated} added`)
  if (run.itemsUpdated > 0) parts.push(`${run.itemsUpdated} updated`)
  if (run.itemsSkipped > 0) parts.push(`${run.itemsSkipped} skipped`)
  return { at, tone: 'success', summary: parts.length ? parts.join(', ') : 'no changes' }
}

/** Active feeds whose most recent fetch left an unresolved error. */
export function selectFailingFeeds(feeds: RssFeed[]): RssFeed[] {
  return feeds.filter((f) => f.active && f.lastError != null)
}

export interface ErrorItem {
  kind: 'feed' | 'sync'
  label: string
  message: string
  count: number | null
  at: string | null
}

export function assembleErrors(failingFeeds: RssFeed[], errorRuns: SyncRun[]): ErrorItem[] {
  const feedItems: ErrorItem[] = failingFeeds.map((f) => ({
    kind: 'feed',
    label: f.label,
    message: f.lastError ?? 'Unknown error',
    count: f.consecutiveErrors,
    at: f.lastErrorAt,
  }))
  const syncItems: ErrorItem[] = errorRuns.map((r) => ({
    kind: 'sync',
    label: r.source,
    message: r.errorMessage ?? 'Unknown error',
    count: null,
    at: r.completedAt ?? r.startedAt,
  }))
  const ms = (iso: string | null) => (iso ? new Date(iso).getTime() : 0)
  return [...feedItems, ...syncItems].sort((a, b) => ms(b.at) - ms(a.at))
}

export { relativeTime } from '@/lib/format-time'
