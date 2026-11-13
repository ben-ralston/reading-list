// Askwho Casts conversion stages (#317) — pure, shared by the app, the
// polling hook, the sync, and the Mac daemon (awc-agent/). No I/O here.

export const AWC_STAGES = [
  'queued', 'starting', 'submitting_url', 'building_script', 'generating', 'done', 'failed',
] as const
export type AwcStage = (typeof AWC_STAGES)[number]

// Stages the agent itself may report via awc-agent/bin/awc-status. Anything
// else written to the status file is ignored (prompt-injection containment).
const AGENT_STAGES = ['submitting_url', 'building_script', 'generating'] as const
export type AgentStage = (typeof AGENT_STAGES)[number]

export const AWC_ACTIVE_STAGES: readonly AwcStage[] = ['queued', 'starting', 'submitting_url', 'building_script', 'generating']
export const AWC_IN_FLIGHT_STAGES: readonly AwcStage[] = ['starting', 'submitting_url', 'building_script', 'generating']

export const AWC_HEARTBEAT_KEY = 'awc_agent_heartbeat'
export const AWC_HEARTBEAT_STALE_SECONDS = 120
export const AWC_QUEUED_OFFLINE_SECONDS = 60

const LABELS: Record<AwcStage, string> = {
  queued: 'Queued', starting: 'Starting', submitting_url: 'Submitting',
  building_script: 'Writing script', generating: 'Recording', done: 'Done', failed: 'Failed',
}

// What a conversion makes: the article, or its comments section (#368).
export type AwcKind = 'article' | 'comments'

export interface AwcConversionDB {
  kind?: string
  id: number
  status: string
  error: string | null
  requested_at: string
  updated_at: string
}

export interface AwcConversionSummary {
  // Absent on optimistic rows and in older tests: treated as 'article'.
  kind?: AwcKind
  id: number
  status: AwcStage
  error: string | null
  requestedAt: string
  updatedAt: string
}

function isStage(s: string): s is AwcStage {
  return (AWC_STAGES as readonly string[]).includes(s)
}

export function isActiveStage(s: string | null | undefined): boolean {
  return s != null && (AWC_ACTIVE_STAGES as readonly string[]).includes(s)
}

export function isAgentStage(s: string): s is AgentStage {
  return (AGENT_STAGES as readonly string[]).includes(s)
}

export function summaryFromDb(row: AwcConversionDB): AwcConversionSummary {
  return {
    kind: row.kind === 'comments' ? 'comments' : 'article',
    id: row.id,
    status: row.status as AwcStage,
    error: row.error,
    requestedAt: row.requested_at,
    updatedAt: row.updated_at,
  }
}

// The daemon's warning that an episode is too cheap to be the whole article
// (#363). Failed rows hold agent-influenced text, which must not earn this calmer
// pill: hence the status check, and the exact format, because markDoneForItem can
// move a failed row to done with its error intact.
export function isShortEpisode(c: { status: string; error: string | null } | null | undefined): boolean {
  return (c?.status === 'generating' || c?.status === 'done') && /^short episode: \d+ credits for about [\d,]+ words$/.test(c.error ?? '')
}

// The card cares about the newest request only. 'done' maps to null: the
// attached episode hides the Convert action. The exception is a short episode,
// which stays visible after it attaches.
export function latestConversionSummary(rows: AwcConversionDB[] | null | undefined): AwcConversionSummary | null {
  if (!rows || rows.length === 0) return null
  const latest = rows.reduce((a, b) => (b.id > a.id ? b : a))
  if (!isStage(latest.status) || (latest.status === 'done' && !isShortEpisode(latest))) return null
  return summaryFromDb(latest)
}

// The agent's error when Askwho Casts itself is signed out (#339): its prompt
// reports "not signed in to askwhocasts.com"; older rows used "AWC" or the
// app. host. An article site's sign-in page is a different failure, so the
// host must end there (not awc-news.com or askwhocasts.com.example.net).
const AWC_SIGNED_OUT = /^not signed in to (awc|(app\.|www\.)?askwhocasts\.com)(?![\w-]|\.\w)/i

export function isAwcSignedOut(error: string | null | undefined): boolean {
  return error != null && AWC_SIGNED_OUT.test(error)
}

export function awcBadgeLabel(c: AwcConversionSummary, agentStale: boolean, nowMs: number): string | null {
  const label = stageLabel(c, agentStale, nowMs)
  return label && c.kind === 'comments' ? `Comments: ${label}` : label
}

// Stops with a reason the owner should see at a glance: a title tooltip doesn't show
// on iOS, and neither of these is a bug (#368).
const NAMED_STOPS = new Map([
  ['too few comments yet', 'Too few yet'],
  ['over credit cap', 'Over credit cap'],
])

function stageLabel(c: AwcConversionSummary, agentStale: boolean, nowMs: number): string | null {
  if (isShortEpisode(c)) return 'Short episode'
  if (c.status === 'done') return null
  if (c.status === 'failed' && NAMED_STOPS.has(c.error ?? '')) return NAMED_STOPS.get(c.error ?? '')!
  if (c.status === 'failed' && isAwcSignedOut(c.error)) return 'AWC signed out'
  if (
    c.status === 'queued' &&
    agentStale &&
    nowMs - Date.parse(c.requestedAt) > AWC_QUEUED_OFFLINE_SECONDS * 1000
  ) {
    return 'Queued · Mac offline'
  }
  return LABELS[c.status]
}
