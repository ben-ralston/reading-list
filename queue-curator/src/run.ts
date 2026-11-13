// One dry run: read, build the prompt, ask Claude, validate, print. Writes
// nothing anywhere. Everything external is injected so tests never touch a
// database or the claude binary.
import { buildHistory, toCandidate, type Candidate, type HistoryRow, type ItemRow } from './digest'
import { parsePicks, parsePicksFile, type PicksResult } from './picks'
import { buildPrompt } from './prompt'
import { oneLine } from './text'
import { toolTrace } from './trace'
import { workspaceFiles } from './workspace'

export interface RunDeps {
  loadItems(): Promise<ItemRow[]>
  loadHistory(): Promise<HistoryRow[]>
  template: string
  instructions: string
  runClaude(prompt: string): Promise<string>
  now: Date
  out(line: string): void
}

// The local day, not UTC's: in the evening the UTC date is already tomorrow.
const TODAY_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' })

function describe(c: Candidate): string {
  const length = c.minutes !== null ? `${c.minutes} min` : 'length unknown'
  const state = c.status === '' ? 'new' : `${c.status}${c.progressPct !== null ? ` ${c.progressPct}%` : ''}`
  // Title and author are feed text: never print them raw to a terminal.
  return `${oneLine(c.title)} — ${oneLine(c.author) || 'unknown'} [${length}, ${state}]`
}

export async function runDryRun(deps: RunDeps): Promise<{ ok: boolean }> {
  const [items, historyRows] = await Promise.all([deps.loadItems(), deps.loadHistory()])
  if (items.length === 0) {
    deps.out('failed: no active feed items to rank')
    return { ok: false }
  }
  const candidates = items.map(toCandidate)
  const prompt = buildPrompt({
    template: deps.template,
    instructions: deps.instructions,
    candidates,
    history: buildHistory(historyRows, deps.now.getTime()),
    today: TODAY_FORMAT.format(deps.now),
  })
  deps.out(`${candidates.length} candidates, prompt ${prompt.length} characters`)

  return printPicks(candidates, parsePicks(await deps.runClaude(prompt), new Set(candidates.map((c) => c.id))), deps.out)
}

function printPicks(candidates: Candidate[], result: PicksResult, out: (line: string) => void): { ok: boolean } {
  if (!result.ok) {
    out(`failed: ${result.error}`)
    return { ok: false }
  }
  const byId = new Map(candidates.map((c) => [c.id, c]))
  result.picks.forEach((pick, index) => {
    out(`${index + 1}. ${describe(byId.get(pick.id)!)}`)
    if (pick.reason !== null) out(`   ${pick.reason}`)
  })
  if (result.dropped.length > 0) out(`dropped: ${result.dropped.join('; ')}`)
  return { ok: true }
}

// ---- Tool-enabled mode ----

// The agent's notes are fed back to it every run, so they stay small.
export const MAX_MEMORY_CHARS = 6000

export interface AgentOutcome {
  stream: string
  picksFile: string | null
  memory: string | null
}

export interface AgentDeps {
  loadItems(): Promise<ItemRow[]>
  loadHistory(): Promise<HistoryRow[]>
  template: string
  instructions: string
  loadMemory(): Promise<string>
  saveMemory(text: string): Promise<void>
  runAgent(prompt: string, files: Record<string, string>): Promise<AgentOutcome>
  now: Date
  out(line: string): void
}

export function agentPrompt(template: string, count: number, now: Date): string {
  const values: Record<string, string> = {
    TODAY: TODAY_FORMAT.format(now),
    COUNT: String(count),
    MEMORY_CHARS: String(MAX_MEMORY_CHARS),
  }
  return template.replace(/\{\{(TODAY|COUNT|MEMORY_CHARS)\}\}/g, (_, key: string) => values[key])
}

export type MemoryDecision = { kind: 'keep' } | { kind: 'save'; text: string } | { kind: 'too-long'; length: number }

// What to do with the notes file the agent left behind.
export function memoryDecision(next: string | null, current: string): MemoryDecision {
  if (next === null || next.trim() === '' || next === current) return { kind: 'keep' }
  if (next.length > MAX_MEMORY_CHARS) return { kind: 'too-long', length: next.length }
  return { kind: 'save', text: next }
}

export async function runAgentDryRun(deps: AgentDeps): Promise<{ ok: boolean }> {
  const [items, historyRows, memory] = await Promise.all([deps.loadItems(), deps.loadHistory(), deps.loadMemory()])
  if (items.length === 0) {
    deps.out('failed: no active feed items to rank')
    return { ok: false }
  }
  const candidates = items.map(toCandidate)
  const prompt = agentPrompt(deps.template, candidates.length, deps.now)
  const files = workspaceFiles({ candidates, historyRows, memory, instructions: deps.instructions })
  deps.out(`${candidates.length} candidates, ${historyRows.length} history rows, memory ${memory.length} characters`)

  const outcome = await deps.runAgent(prompt, files)
  const trace = toolTrace(outcome.stream)
  const counts = Object.entries(trace.counts).map(([name, n]) => `${name} ${n}`).join(', ')
  deps.out(`tools: ${counts || 'none'}`)
  for (const url of trace.fetched) deps.out(`fetched: ${url}`)
  for (const query of trace.searched) deps.out(`searched: ${query}`)

  const printed = printPicks(candidates, parsePicksFile(outcome.picksFile, new Set(candidates.map((c) => c.id))), deps.out)
  if (!printed.ok) return printed

  // Notes are kept only from a run whose picks were usable.
  const notes = memoryDecision(outcome.memory, memory)
  if (notes.kind === 'too-long') {
    deps.out(`memory not saved: ${notes.length} characters is over the ${MAX_MEMORY_CHARS} limit`)
  } else if (notes.kind === 'save') {
    await deps.saveMemory(notes.text)
    deps.out(`memory updated (${notes.text.length} characters)`)
  }
  return { ok: true }
}
