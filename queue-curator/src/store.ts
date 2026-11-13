// The curator's only database writes: one curation_runs row per run, and its
// notes in app_settings. Everything else it does with the database is a read.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CurateDeps, RunRecord } from './curate'

export const MEMORY_KEY = 'queue_curator_memory'
export const PRUNE_AFTER_DAYS = 30

function check(result: { error: unknown }): void {
  if (!result.error) return
  const message = (result.error as { message?: unknown }).message
  throw new Error(typeof message === 'string' ? message : String(result.error))
}

type Store = Pick<CurateDeps, 'loadMemory' | 'saveMemory' | 'lastSucceeded' | 'lastFailed' | 'recordRun' | 'prune'>

export function createStore(db: SupabaseClient, now: () => Date = () => new Date()): Store {
  const latest = async (status: 'succeeded' | 'failed') => {
    const result = await db
      .from('curation_runs')
      .select('id, input_hash, finished_at')
      .eq('status', status)
      .order('finished_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    check(result)
    return result.data as { id: number; input_hash: string; finished_at: string } | null
  }

  return {
    async loadMemory() {
      const result = await db.from('app_settings').select('value').eq('key', MEMORY_KEY).maybeSingle()
      check(result)
      const value = (result.data as { value?: unknown } | null)?.value
      return typeof value === 'string' ? value : ''
    },

    async saveMemory(text: string) {
      check(await db.from('app_settings').upsert({ key: MEMORY_KEY, value: text }, { onConflict: 'key' }))
    },

    async lastSucceeded() {
      const row = await latest('succeeded')
      return row ? { inputHash: row.input_hash, finishedAt: row.finished_at } : null
    },

    async lastFailed() {
      const row = await latest('failed')
      return row ? { inputHash: row.input_hash, finishedAt: row.finished_at } : null
    },

    async recordRun(run: RunRecord) {
      check(
        await db.from('curation_runs').insert({
          status: run.status,
          started_at: run.startedAt,
          finished_at: run.finishedAt,
          mode: run.mode,
          model: run.model,
          items_considered: run.itemsConsidered,
          input_hash: run.inputHash,
          picks: run.picks,
          tool_summary: run.toolSummary,
          error: run.error,
        }),
      )
    },

    // Old runs go, but never the latest succeeded one: it is what the home
    // screen shows, however long the Mac has been off.
    async prune() {
      const keep = await latest('succeeded')
      const cutoff = new Date(now().getTime() - PRUNE_AFTER_DAYS * 86_400_000).toISOString()
      let query = db.from('curation_runs').delete().lt('finished_at', cutoff)
      if (keep) query = query.neq('id', keep.id)
      check(await query)
    },
  }
}
