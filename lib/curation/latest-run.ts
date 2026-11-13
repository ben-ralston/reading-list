// The latest succeeded queue-curator run (#377), read for the home shortlist.
// Fails open: a missing table, a network error or an empty table all return
// null, and home falls back to pins plus the Recommended formula.

import type { SupabaseClient } from '@supabase/supabase-js'
import { parseCurationPicks, type Curation } from '@/lib/shortlist'

export async function fetchLatestCuration(client: SupabaseClient): Promise<Curation | null> {
  try {
    const { data, error } = await client
      .from('curation_runs')
      .select('finished_at, picks')
      .eq('status', 'succeeded')
      .order('finished_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) {
      console.error('[Curation] Failed to read the latest run:', error)
      return null
    }
    if (!data) return null
    const row = data as { finished_at: string; picks: unknown }
    return { finishedAt: row.finished_at, picks: parseCurationPicks(row.picks) }
  } catch (error) {
    console.error('[Curation] Failed to read the latest run:', error)
    return null
  }
}
