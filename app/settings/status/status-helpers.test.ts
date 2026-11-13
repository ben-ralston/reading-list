import { describe, it, expect } from 'vitest'
import {
  deriveSyncStatus, syncStatusDot, formatRun,
  selectFailingFeeds, assembleErrors, relativeTime,
} from './status-helpers'
import type { SyncRun } from '@/lib/sync/sync-logs-repo'
import type { RssFeed } from '@/lib/rss/feeds-repo'

function run(p: Partial<SyncRun>): SyncRun {
  return {
    id: 1, source: 'spotify', status: 'success',
    startedAt: '2026-05-24T09:00:00Z', completedAt: '2026-05-24T09:01:00Z',
    itemsProcessed: 0, itemsCreated: 0, itemsUpdated: 0, itemsSkipped: 0,
    errorMessage: null, metadata: null, ...p,
  }
}
function feed(p: Partial<RssFeed>): RssFeed {
  return {
    id: 1, url: 'u', label: 'L', authorName: null, platform: 'Substack',
    feedType: 'substack', active: true, createdAt: 't', updatedAt: 't',
    lastFetchedAt: null, lastSuccessAt: null, lastError: null, lastErrorAt: null,
    lastItemCount: null, consecutiveErrors: 0, ...p,
  }
}

describe('deriveSyncStatus', () => {
  it('never when no runs', () => {
    expect(deriveSyncStatus([])).toEqual({ state: 'never', lastSuccessAt: null, lastRun: null })
  })
  it('healthy when the latest run succeeded', () => {
    const s = deriveSyncStatus([run({ status: 'success', completedAt: 'C' })])
    expect(s.state).toBe('healthy')
    expect(s.lastSuccessAt).toBe('C')
  })
  it('failing when latest errored; lastSuccessAt comes from prior success', () => {
    const s = deriveSyncStatus([
      run({ id: 2, status: 'error', completedAt: null }),
      run({ id: 1, status: 'success', completedAt: 'C1' }),
    ])
    expect(s.state).toBe('failing')
    expect(s.lastSuccessAt).toBe('C1')
    expect(s.lastRun?.id).toBe(2)
  })
  it('syncing when the latest run is running', () => {
    expect(deriveSyncStatus([run({ status: 'running' })]).state).toBe('syncing')
  })
  it('degraded when the latest run is partial', () => {
    expect(deriveSyncStatus([run({ status: 'partial' })]).state).toBe('degraded')
  })
})

describe('syncStatusDot', () => {
  it('maps each state to a color', () => {
    expect(syncStatusDot('healthy').color).toBe('bg-green-500')
    expect(syncStatusDot('failing').color).toBe('bg-red-500')
    expect(syncStatusDot('degraded').color).toBe('bg-amber-500')
    expect(syncStatusDot('syncing').color).toBe('bg-yellow-500')
    expect(syncStatusDot('never').color).toBe('bg-gray-300')
  })
})

describe('formatRun', () => {
  it('summarizes counts for a successful run', () => {
    const f = formatRun(run({ itemsCreated: 3, itemsUpdated: 1 }))
    expect(f.tone).toBe('success')
    expect(f.summary).toBe('3 added, 1 updated')
  })
  it('reports no changes when all counts are zero', () => {
    expect(formatRun(run({})).summary).toBe('no changes')
  })
  it('shows the error message for an error run', () => {
    const f = formatRun(run({ status: 'error', errorMessage: 'token refresh failed' }))
    expect(f.tone).toBe('error')
    expect(f.summary).toBe('token refresh failed')
  })
  it('flags a partial run with the failed-feed count from metadata', () => {
    const f = formatRun(run({ status: 'partial', metadata: { feedErrors: [{}, {}] } }))
    expect(f.tone).toBe('warn')
    expect(f.summary).toBe('partial — 2 feeds failed')
  })
  it('falls back to a generic partial message when metadata is missing', () => {
    const f = formatRun(run({ status: 'partial', metadata: null }))
    expect(f.tone).toBe('warn')
    expect(f.summary).toBe('partial — some items failed')
  })
  it('surfaces item-write failures on a feed-less source (RLV-024)', () => {
    // /api/sync sources have no feeds, so a partial from lost item writes must
    // report itemErrors — not the nonsensical "some feeds failed".
    const f = formatRun(run({ status: 'partial', metadata: { itemErrors: 3 } }))
    expect(f.tone).toBe('warn')
    expect(f.summary).toBe('partial — 3 items failed to persist')
  })
  it('singularizes a lone item failure', () => {
    const f = formatRun(run({ status: 'partial', metadata: { itemErrors: 1 } }))
    expect(f.summary).toBe('partial — 1 item failed to persist')
  })
  it('combines feed and item failures when both are present (RSS)', () => {
    const f = formatRun(run({ status: 'partial', metadata: { feedErrors: [{}], itemErrors: 2 } }))
    expect(f.summary).toBe('partial — 1 feed failed, 2 items failed to persist')
  })
})

describe('selectFailingFeeds', () => {
  it('keeps active feeds with a lastError; drops healthy and disabled', () => {
    const out = selectFailingFeeds([
      feed({ id: 1, lastError: '404' }),
      feed({ id: 2, lastError: null }),
      feed({ id: 3, lastError: 'x', active: false }),
    ])
    expect(out.map((f) => f.id)).toEqual([1])
  })
})

describe('assembleErrors', () => {
  it('merges feed + sync errors, newest first', () => {
    const items = assembleErrors(
      [feed({ label: 'Dean', lastError: '404', consecutiveErrors: 3, lastErrorAt: '2026-05-24T07:00:00Z' })],
      [run({ source: 'spotify', status: 'error', errorMessage: 'token', completedAt: '2026-05-24T08:00:00Z' })],
    )
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ kind: 'sync', label: 'spotify', message: 'token' })
    expect(items[1]).toMatchObject({ kind: 'feed', label: 'Dean', count: 3 })
  })
  it('returns [] when nothing is failing', () => {
    expect(assembleErrors([], [])).toEqual([])
  })
})

describe('relativeTime', () => {
  it('returns an em dash for null', () => {
    expect(relativeTime(null)).toBe('—')
  })
})
