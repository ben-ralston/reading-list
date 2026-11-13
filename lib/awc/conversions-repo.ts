// Single touchpoint for awc_conversions + the agent heartbeat (#317). Every
// function takes the client explicitly: the app passes the lib/supabase
// singleton, the Mac daemon (awc-agent/) its own service-role client.
import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeTitle } from '@/lib/sync/normalize-title'
import {
  AWC_ACTIVE_STAGES, AWC_HEARTBEAT_KEY, AWC_IN_FLIGHT_STAGES, summaryFromDb,
  type AgentStage, type AwcConversionDB, type AwcConversionSummary, type AwcKind, type AwcStage,
} from './stages'

const SUMMARY_COLUMNS = 'id, kind, status, error, requested_at, updated_at'
const POLL_RECENT_MS = 15 * 60 * 1000

export interface AwcClaim {
  id: number
  kind: AwcKind
  contentItemId: number
  sourceUrl: string
  attempts: number
  title: string
  author: string
  wordCount: number | null
}

export type AgentResult =
  | { outcome: 'generating'; path: 'url' | 'script'; episodeTitle: string; credits: number | null; reportedWords?: number; warning?: string }
  | { outcome: 'failed'; path: 'url' | 'script' | null; error: string }

export async function requestConversion(
  db: SupabaseClient, contentItemId: number, sourceUrl: string, kind: AwcKind = 'article',
): Promise<{ ok: true; conversion: AwcConversionSummary } | { ok: false; reason: 'already_active' }> {
  const { data, error } = await db
    .from('awc_conversions')
    .insert({ content_item_id: contentItemId, source_url: sourceUrl, kind })
    .select(SUMMARY_COLUMNS)
    .single()
  if (error) {
    if ((error as { code?: string }).code === '23505') return { ok: false, reason: 'already_active' }
    throw error
  }
  return { ok: true, conversion: summaryFromDb(data as AwcConversionDB) }
}

// The item's active (not done/failed) request, if any — at most one exists.
export async function getActiveForItem(db: SupabaseClient, contentItemId: number): Promise<AwcConversionSummary | null> {
  const { data, error } = await db
    .from('awc_conversions')
    .select(SUMMARY_COLUMNS)
    .eq('content_item_id', contentItemId)
    .in('status', [...AWC_ACTIVE_STAGES])
    .maybeSingle()
  if (error) throw error
  return data ? summaryFromDb(data as AwcConversionDB) : null
}

export async function listForPolling(
  db: SupabaseClient, nowMs: number,
): Promise<Array<AwcConversionSummary & { contentItemId: number }>> {
  const since = new Date(nowMs - POLL_RECENT_MS).toISOString()
  const { data, error } = await db
    .from('awc_conversions')
    .select(`${SUMMARY_COLUMNS}, content_item_id`)
    .or(`status.in.(${AWC_ACTIVE_STAGES.join(',')}),updated_at.gt.${since}`)
    .order('id', { ascending: true })
  if (error) throw error
  return ((data ?? []) as Array<AwcConversionDB & { content_item_id: number }>).map((r) => ({
    ...summaryFromDb(r), contentItemId: r.content_item_id,
  }))
}

export async function getHeartbeatAgeSeconds(db: SupabaseClient, nowMs: number): Promise<number | null> {
  const { data, error } = await db.from('app_settings').select('value').eq('key', AWC_HEARTBEAT_KEY).maybeSingle()
  if (error) throw error
  const at = data ? Date.parse((data as { value: string }).value) : NaN
  return Number.isNaN(at) ? null : Math.max(0, Math.round((nowMs - at) / 1000))
}

export async function writeHeartbeat(db: SupabaseClient, nowIso: string): Promise<void> {
  const { error } = await db.from('app_settings').upsert({ key: AWC_HEARTBEAT_KEY, value: nowIso })
  if (error) throw error
}

export async function claimNext(db: SupabaseClient): Promise<AwcClaim | null> {
  const { data, error } = await db.rpc('claim_awc_conversion', { p_kinds: ['article', 'comments'] })
  if (error) throw error
  const row = (data as Array<Record<string, unknown>> | null)?.[0]
  if (!row) return null
  return {
    id: row.id as number,
    kind: row.kind as AwcKind,
    contentItemId: row.content_item_id as number,
    sourceUrl: row.source_url as string,
    attempts: row.attempts as number,
    title: row.title as string,
    author: row.author as string,
    wordCount: (row.word_count as number | null) ?? null,
  }
}

// Agent-reported stage. Only in-flight rows move, so a late report can't
// resurrect a row the sync marked done or the claim RPC failed.
export async function setStage(db: SupabaseClient, id: number, stage: AgentStage): Promise<void> {
  const update: Record<string, unknown> = { status: stage }
  if (stage === 'generating') update.generating_at = new Date().toISOString()
  const { error } = await db.from('awc_conversions').update(update).eq('id', id).in('status', [...AWC_IN_FLIGHT_STAGES])
  if (error) throw error
}

// Pre-Generate stages: a failure may only land while the row is still in one
// of these. Once the agent reported 'generating', credits are spent — a late
// failure (timeout, max turns) must not flip the row to 'failed' and invite a
// paid Retry; the episode will still arrive via the feed.
const PRE_GENERATE_STAGES: readonly AwcStage[] = ['starting', 'submitting_url', 'building_script']

export async function recordResult(db: SupabaseClient, id: number, result: AgentResult): Promise<void> {
  const now = new Date().toISOString()
  const query =
    result.outcome === 'generating'
      ? db.from('awc_conversions')
          .update({
            status: 'generating', path: result.path, episode_title: result.episodeTitle, credits: result.credits, generating_at: now,
            // Kept in error, which markDoneForItem leaves alone, so the card
            // still shows it once the episode attaches (#363).
            ...(result.warning ? { error: result.warning } : {}),
          })
          .eq('id', id)
          .in('status', [...AWC_IN_FLIGHT_STAGES])
      : db.from('awc_conversions')
          .update({ status: 'failed', path: result.path, error: result.error.slice(0, 500), completed_at: now })
          .eq('id', id)
          .in('status', [...PRE_GENERATE_STAGES])
  const { error } = await query
  if (error) throw error
}

export async function countRecentGenerating(db: SupabaseClient, sinceIso: string): Promise<number> {
  const { data, error } = await db
    .from('awc_conversions').select('id').eq('status', 'generating').gt('generating_at', sinceIso)
  if (error) throw error
  return (data ?? []).length
}

// Link-less (Script-tab) episodes match ONLY a generating script request with
// the same normalized title — never the general title fallback, so unrelated
// Studio episodes stay unmatched. Ambiguity → null.
export async function findGeneratingScriptConversion(
  db: SupabaseClient, episodeTitle: string,
): Promise<{ id: number; contentItemId: number; kind: AwcKind } | null> {
  const incoming = normalizeTitle(episodeTitle)
  if (incoming === '') return null
  const { data, error } = await db
    .from('awc_conversions')
    .select('id, content_item_id, episode_title, kind')
    .eq('status', 'generating')
    .eq('path', 'script')
  if (error) throw error
  const hits = ((data ?? []) as Array<{ id: number; content_item_id: number; episode_title: string | null; kind?: string }>)
    .filter((r) => r.episode_title != null && normalizeTitle(r.episode_title) === incoming)
  if (hits.length !== 1) return null
  return { id: hits[0].id, contentItemId: hits[0].content_item_id, kind: hits[0].kind === 'comments' ? 'comments' : 'article' }
}

// The item now has this kind of episode: close every row of that kind that
// isn't done yet — including a 'failed' one (e.g. the agent timed out after
// clicking Generate, or the owner finished it manually), so no stale pill survives
// the audio. Scoped by kind (#368): each sync pass re-runs this for an existing
// article episode, which must not close a comments request.
export async function markDoneForItem(db: SupabaseClient, contentItemId: number, kind: AwcKind = 'article'): Promise<void> {
  const { error } = await db
    .from('awc_conversions')
    .update({ status: 'done', completed_at: new Date().toISOString() })
    .eq('content_item_id', contentItemId)
    .eq('kind', kind)
    .neq('status', 'done')
  if (error) throw error
}
