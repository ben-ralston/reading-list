// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { createStore, MEMORY_KEY, PRUNE_AFTER_DAYS } from './store'
import type { RunRecord } from './curate'

// A tiny recording stand-in for the supabase-js query builder.
function fakeDb(results: Record<string, { data?: unknown; error?: unknown }>) {
  const calls: { table: string; ops: [string, ...unknown[]][] }[] = []
  const db = {
    from(table: string) {
      const call = { table, ops: [] as [string, ...unknown[]][] }
      calls.push(call)
      const builder: Record<string, unknown> = {}
      for (const op of ['select', 'insert', 'upsert', 'delete', 'eq', 'neq', 'lt', 'order', 'limit', 'maybeSingle']) {
        builder[op] = (...args: unknown[]) => { call.ops.push([op, ...args]); return builder }
      }
      builder.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null, ...results[table] })
      return builder
    },
  }
  return { db: db as never, calls }
}

const run: RunRecord = {
  status: 'succeeded', startedAt: '2026-11-10T01:00:00.000Z', finishedAt: '2026-11-10T01:02:00.000Z', mode: 'agent',
  model: 'opus', itemsConsidered: 322, inputHash: 'abc', picks: [{ id: 5, reason: 'Short' }],
  toolSummary: { counts: { Read: 2 }, fetched: [], searched: [] }, error: null,
}

describe('createStore', () => {
  it('reads notes from app_settings, empty when there are none', async () => {
    const some = fakeDb({ app_settings: { data: { value: 'my notes' } } })
    expect(await createStore(some.db).loadMemory()).toBe('my notes')
    expect(some.calls[0].ops).toContainEqual(['eq', 'key', MEMORY_KEY])
    expect(await createStore(fakeDb({}).db).loadMemory()).toBe('')
  })

  it('upserts notes under the memory key', async () => {
    const { db, calls } = fakeDb({})
    await createStore(db).saveMemory('new notes')
    expect(calls[0].table).toBe('app_settings')
    expect(calls[0].ops[0]).toEqual(['upsert', { key: MEMORY_KEY, value: 'new notes' }, { onConflict: 'key' }])
  })

  it('writes a run in snake_case columns', async () => {
    const { db, calls } = fakeDb({})
    await createStore(db).recordRun(run)
    expect(calls[0].table).toBe('curation_runs')
    expect(calls[0].ops[0]).toEqual(['insert', {
      status: 'succeeded', started_at: run.startedAt, finished_at: run.finishedAt, mode: 'agent', model: 'opus',
      items_considered: 322, input_hash: 'abc', picks: run.picks, tool_summary: run.toolSummary, error: null,
    }])
  })

  it('returns the latest succeeded run, or null', async () => {
    const { db, calls } = fakeDb({ curation_runs: { data: { id: 9, input_hash: 'abc', finished_at: '2026-11-10T01:02:00Z' } } })
    expect(await createStore(db).lastSucceeded()).toEqual({ inputHash: 'abc', finishedAt: '2026-11-10T01:02:00Z' })
    expect(calls[0].ops).toContainEqual(['eq', 'status', 'succeeded'])
    expect(calls[0].ops).toContainEqual(['order', 'finished_at', { ascending: false }])
    expect(await createStore(fakeDb({}).db).lastSucceeded()).toBeNull()
  })

  it('prunes old runs but never the latest succeeded one', async () => {
    const { db, calls } = fakeDb({ curation_runs: { data: { id: 9, input_hash: 'abc', finished_at: '2020-01-01T00:00:00Z' } } })
    await createStore(db, () => new Date('2026-11-10T00:00:00Z')).prune()
    const del = calls.find((c) => c.ops[0][0] === 'delete')!
    const cutoff = new Date(Date.parse('2026-11-10T00:00:00Z') - PRUNE_AFTER_DAYS * 86_400_000).toISOString()
    expect(del.ops).toContainEqual(['lt', 'finished_at', cutoff])
    expect(del.ops).toContainEqual(['neq', 'id', 9])
  })

  it('throws the database message on a failed write', async () => {
    const { db } = fakeDb({ curation_runs: { error: { message: 'permission denied' } } })
    await expect(createStore(db).recordRun(run)).rejects.toThrow('permission denied')
  })

  it('returns the latest failed run for the retry backoff', async () => {
    const { db, calls } = fakeDb({ curation_runs: { data: { id: 3, input_hash: 'zzz', finished_at: '2026-11-10T00:00:00Z' } } })
    expect(await createStore(db).lastFailed()).toEqual({ inputHash: 'zzz', finishedAt: '2026-11-10T00:00:00Z' })
    expect(calls[0].ops).toContainEqual(['eq', 'status', 'failed'])
  })
})
