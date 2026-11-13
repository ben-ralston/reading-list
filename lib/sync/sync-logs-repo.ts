import { supabase } from '@/lib/supabase'

export interface SyncRun {
  id: number
  source: string
  status: 'running' | 'success' | 'partial' | 'error'
  startedAt: string | null
  completedAt: string | null
  itemsProcessed: number
  itemsCreated: number
  itemsUpdated: number
  itemsSkipped: number
  errorMessage: string | null
  metadata: Record<string, unknown> | null
}

interface SyncLogRow {
  id: number
  source: string
  status: 'running' | 'success' | 'partial' | 'error'
  started_at: string | null
  completed_at: string | null
  items_processed: number | null
  items_created: number | null
  items_updated: number | null
  items_skipped: number | null
  error_message: string | null
  metadata: Record<string, unknown> | null
}

function rowToRun(r: SyncLogRow): SyncRun {
  return {
    id: r.id,
    source: r.source,
    status: r.status,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    itemsProcessed: r.items_processed ?? 0,
    itemsCreated: r.items_created ?? 0,
    itemsUpdated: r.items_updated ?? 0,
    itemsSkipped: r.items_skipped ?? 0,
    errorMessage: r.error_message,
    metadata: r.metadata,
  }
}

/** Most recent sync runs for one source, newest first. Returns [] on DB error. */
export async function listRecentRuns(source: string, limit = 5): Promise<SyncRun[]> {
  const { data, error } = await supabase
    .from('sync_logs')
    .select('*')
    .eq('source', source)
    .order('started_at', { ascending: false })
    .limit(limit)
  if (error) {
    console.error('[sync-logs-repo] listRecentRuns failed:', source, error.message)
    return []
  }
  return (data as SyncLogRow[]).map(rowToRun)
}

/** Most recent error runs across all sources, newest first. Returns [] on DB error. */
export async function listRecentErrors(limit = 20): Promise<SyncRun[]> {
  const { data, error } = await supabase
    .from('sync_logs')
    .select('*')
    .eq('status', 'error')
    .order('started_at', { ascending: false })
    .limit(limit)
  if (error) {
    console.error('[sync-logs-repo] listRecentErrors failed:', error.message)
    return []
  }
  return (data as SyncLogRow[]).map(rowToRun)
}
