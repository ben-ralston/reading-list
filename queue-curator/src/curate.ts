// One real, unattended curation run: skip if nothing changed, otherwise run
// the agent, validate its picks and save one curation_runs row. The curator
// writes only that row and its notes; it never touches content_items. A run
// that fails leaves the previous picks and notes in place.
import { toCandidate, type Candidate, type HistoryRow, type ItemRow } from './digest'
import { inputHash } from './hash'
import { parsePicksFile, type Pick as PickEntry } from './picks'
import { PROMPT_VERSION } from './prompt'
import { agentPrompt, memoryDecision, MAX_MEMORY_CHARS, type AgentOutcome } from './run'
import { oneLine } from './text'
import { resultDetail, toolTrace, type ToolTrace } from './trace'
import { workspaceFiles } from './workspace'

// "Not now" keeps an item off the shortlist this long; then it is a
// candidate again, with the dismissal date shown to Claude.
// Shared with the app's home shortlist (#377); one number for both.
import { DISMISS_HOLD_DAYS } from '../../lib/shortlist'
export { DISMISS_HOLD_DAYS }
// Unchanged input is re-ranked at most this often.
export const SKIP_UNCHANGED_HOURS = 24
// An input that just failed is not retried for this long: a failure that
// repeats on the same queue would otherwise burn a full run every hour.
export const RETRY_FAILED_HOURS = 6

// Quiet hours, in the configured local time zone: no runs from 10 pm up to 5 am. The
// plist only schedules 05:45 to 21:45, but launchd also starts the job at
// login and after a wake that missed a slot, so the job checks for itself.
export const QUIET_FROM_HOUR = 22
export const QUIET_UNTIL_HOUR = 5
const LOCAL_HOUR = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hourCycle: 'h23' })

export function inQuietHours(now: Date): boolean {
  const hour = Number(LOCAL_HOUR.format(now))
  return hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR
}

const MAX_ERROR_CHARS = 200

type FailureKind = 'read_failed' | 'prepare_failed' | 'agent_failed' | 'no_usable_picks' | 'save_failed'

export interface RunRecord {
  status: 'succeeded' | 'failed'
  startedAt: string
  finishedAt: string
  mode: 'agent'
  model: string
  itemsConsidered: number
  inputHash: string
  picks: PickEntry[]
  toolSummary: ToolTrace | null
  error: string | null
}

export interface CurateDeps {
  loadItems(): Promise<ItemRow[]>
  loadHistory(): Promise<HistoryRow[]>
  loadMemory(): Promise<string>
  saveMemory(text: string): Promise<void>
  lastSucceeded(): Promise<{ inputHash: string; finishedAt: string } | null>
  lastFailed(): Promise<{ inputHash: string; finishedAt: string } | null>
  recordRun(run: RunRecord): Promise<void>
  prune(): Promise<void>
  runAgent(prompt: string, files: Record<string, string>): Promise<AgentOutcome>
  template: string
  instructions: string
  model: string
  now(): Date
  log(line: string): void
  alert(message: string, extra: Record<string, unknown>): void
}

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error
    : typeof (error as { message?: unknown })?.message === 'string' ? (error as { message: string }).message : String(error)
  const cleaned = oneLine(raw) || 'unknown error'
  return cleaned.length > MAX_ERROR_CHARS ? `${cleaned.slice(0, MAX_ERROR_CHARS - 1)}…` : cleaned
}

function held(row: ItemRow, nowMs: number): boolean {
  if (!row.shortlist_dismissed_at) return false
  const at = Date.parse(row.shortlist_dismissed_at)
  return !Number.isNaN(at) && nowMs - at < DISMISS_HOLD_DAYS * 86_400_000
}

export async function curate(deps: CurateDeps): Promise<'succeeded' | 'skipped' | 'failed'> {
  const started = deps.now()
  if (inQuietHours(started)) {
    deps.log('skipped: quiet hours (10 pm to 5 am)')
    return 'skipped'
  }
  // The error text can contain words from the model, the CLI or the feeds.
  // It goes to the local log and the service-role-only curation_runs row;
  // the alert, which the alerting job can turn into a notification, carries only
  // a fixed category.
  const fail = (kind: FailureKind, error: string) => {
    deps.log(`FAILED: ${error}`)
    deps.alert('queue curation failed', { kind })
    return 'failed' as const
  }

  type Last = Awaited<ReturnType<CurateDeps['lastSucceeded']>>
  let items: ItemRow[], historyRows: HistoryRow[], memory: string, last: Last, lastFailed: Last
  try {
    ;[items, historyRows, memory, last, lastFailed] = await Promise.all([
      deps.loadItems(), deps.loadHistory(), deps.loadMemory(), deps.lastSucceeded(), deps.lastFailed(),
    ])
  } catch (error) {
    return fail('read_failed', `could not read the queue: ${errorText(error)}`)
  }

  let candidates: Candidate[], prompt: string, files: Record<string, string>, hash: string
  try {
    candidates = items.filter((row) => !held(row, started.getTime())).map(toCandidate)
    prompt = agentPrompt(deps.template, candidates.length, started)
    files = workspaceFiles({ candidates, historyRows, memory, instructions: deps.instructions })
    hash = inputHash({ files, prompt, model: deps.model, promptVersion: PROMPT_VERSION })
  } catch (error) {
    return fail('prepare_failed', `could not prepare the run: ${errorText(error)}`)
  }
  if (candidates.length === 0) {
    deps.log('skipped: nothing to rank')
    return 'skipped'
  }

  if (last && last.inputHash === hash) {
    const ageHours = (started.getTime() - Date.parse(last.finishedAt)) / 3_600_000
    if (ageHours < SKIP_UNCHANGED_HOURS) {
      deps.log(`skipped: nothing changed since the last run ${ageHours.toFixed(1)} h ago`)
      return 'skipped'
    }
  }

  if (lastFailed && lastFailed.inputHash === hash) {
    const ageHours = (started.getTime() - Date.parse(lastFailed.finishedAt)) / 3_600_000
    if (ageHours < RETRY_FAILED_HOURS) {
      deps.log(`skipped: this input failed ${ageHours.toFixed(1)} h ago; retrying after ${RETRY_FAILED_HOURS} h`)
      return 'skipped'
    }
  }

  const record = (over: Pick<RunRecord, 'status' | 'picks' | 'toolSummary' | 'error'>): RunRecord => ({
    startedAt: started.toISOString(),
    finishedAt: deps.now().toISOString(),
    mode: 'agent',
    model: deps.model,
    itemsConsidered: candidates.length,
    inputHash: hash,
    ...over,
  })
  const recordFailure = async (kind: FailureKind, error: string, toolSummary: ToolTrace | null) => {
    try {
      await deps.recordRun(record({ status: 'failed', picks: [], toolSummary, error }))
    } catch {
      // The log line and the alert below still report it.
    }
    return fail(kind, error)
  }

  let outcome: AgentOutcome
  try {
    outcome = await deps.runAgent(prompt, files)
  } catch (error) {
    return recordFailure('agent_failed', errorText(error), null)
  }
  const trace = toolTrace(outcome.stream)
  const result = parsePicksFile(outcome.picksFile, new Set(candidates.map((c) => c.id)))
  if (!result.ok) {
    // No file at all usually means the session died early; say how it ended.
    const detail = outcome.picksFile === null ? resultDetail(outcome.stream) : null
    return recordFailure('no_usable_picks', detail ? `${result.error} (${detail})` : result.error, trace)
  }

  try {
    await deps.recordRun(record({ status: 'succeeded', picks: result.picks, toolSummary: trace, error: null }))
  } catch (error) {
    return fail('save_failed', `could not save the run: ${errorText(error)}`)
  }

  // Notes and pruning are best-effort: the picks are already saved.
  let notes = 'notes unchanged'
  const decision = memoryDecision(outcome.memory, memory)
  if (decision.kind === 'too-long') {
    notes = `notes not saved (${decision.length} characters, limit ${MAX_MEMORY_CHARS})`
  } else if (decision.kind === 'save') {
    try {
      await deps.saveMemory(decision.text)
      notes = `notes updated (${decision.text.length} characters)`
    } catch (error) {
      notes = 'notes not saved'
      deps.log(`warning: notes not saved: ${errorText(error)}`)
    }
  }
  try {
    await deps.prune()
  } catch (error) {
    deps.log(`warning: old runs not pruned: ${errorText(error)}`)
  }

  const tools = Object.entries(trace.counts).map(([name, n]) => `${name} ${n}`).join(' ') || 'none'
  deps.log(`ok: ${result.picks.length} picks, ${candidates.length} candidates, tools ${tools}, ${result.dropped.length} dropped, ${notes}`)
  return 'succeeded'
}
