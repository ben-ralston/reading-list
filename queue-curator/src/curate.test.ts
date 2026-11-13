// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { curate, inQuietHours, type CurateDeps, type RunRecord } from './curate'
import { MAX_MEMORY_CHARS, type AgentOutcome } from './run'
import type { ItemRow } from './digest'

const NOW = new Date('2026-11-10T01:30:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()
const item = (id: number, over: Partial<ItemRow> = {}): ItemRow => ({
  id, title: `Title ${id}`, author: 'Zvi', status: '', progress: null, published_on: '2026-11-01',
  created_at: '2026-11-02T00:00:00Z', status_changed_at: null, added_by: null,
  duration_seconds: 600, word_count: null, summary: null, sources: [], ...over,
})
const fetchEvent = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'Zvi' } }] } })
const good: AgentOutcome = { stream: fetchEvent, picksFile: '{"picks":[{"id":2,"reason":"Strong"},{"id":1,"reason":""},{"id":99,"reason":""}]}', memory: 'new notes' }

function setup(over: Partial<CurateDeps> = {}, outcome: AgentOutcome | Error = good) {
  const state = {
    logs: [] as string[], alerts: [] as { message: string; extra: Record<string, unknown> }[],
    runs: [] as RunRecord[], saved: [] as string[], pruned: 0,
    calls: [] as { prompt: string; files: Record<string, string> }[],
  }
  const deps: CurateDeps = {
    loadItems: async () => [item(1), item(2)],
    loadHistory: async () => [],
    loadMemory: async () => 'old notes',
    saveMemory: async (text) => { state.saved.push(text) },
    lastSucceeded: async () => null,
    lastFailed: async () => null,
    recordRun: async (run) => { state.runs.push(run) },
    prune: async () => { state.pruned++ },
    runAgent: async (prompt, files) => {
      state.calls.push({ prompt, files })
      if (outcome instanceof Error) throw outcome
      return outcome
    },
    template: 'Today {{TODAY}}; {{COUNT}} items; cap {{MEMORY_CHARS}}',
    instructions: 'listen',
    model: 'opus',
    now: () => NOW,
    log: (line) => state.logs.push(line),
    alert: (message, extra) => state.alerts.push({ message, extra }),
    ...over,
  }
  return { deps, state }
}

describe('curate', () => {
  it('records a succeeded run with validated picks, saves notes and prunes', async () => {
    const { deps, state } = setup()
    expect(await curate(deps)).toBe('succeeded')
    expect(state.runs).toHaveLength(1)
    expect(state.runs[0]).toMatchObject({
      status: 'succeeded', mode: 'agent', model: 'opus', itemsConsidered: 2, error: null,
      picks: [{ id: 2, reason: 'Strong' }, { id: 1, reason: null }],
      toolSummary: { counts: { Grep: 1 }, fetched: [], searched: [] },
      startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(),
    })
    expect(state.runs[0].inputHash).toMatch(/^[0-9a-f]{64}$/)
    expect(state.saved).toEqual(['new notes'])
    expect(state.pruned).toBe(1)
    expect(state.logs.at(-1)).toMatch(/^ok: 2 picks, 2 candidates, tools Grep 1, 1 dropped, notes updated/)
    expect(state.alerts).toEqual([])
    expect(state.calls[0].prompt).toBe(`Today 2026-11-09; 2 items; cap ${MAX_MEMORY_CHARS}`)
  })

  it('makes no model call and saves nothing when the input is unchanged', async () => {
    const first = setup()
    await curate(first.deps)
    const hash = first.state.runs[0].inputHash
    const { deps, state } = setup({ lastSucceeded: async () => ({ inputHash: hash, finishedAt: daysAgo(0.1) }), loadMemory: async () => 'notes changed since' })
    expect(await curate(deps)).toBe('skipped')
    expect(state.calls).toEqual([])
    expect(state.runs).toEqual([])
    expect(state.saved).toEqual([])
    expect(state.logs.at(-1)).toMatch(/^skipped: /)
  })

  it('runs again when the unchanged run is over 24 hours old, or the queue changed', async () => {
    const first = setup()
    await curate(first.deps)
    const hash = first.state.runs[0].inputHash
    const old = setup({ lastSucceeded: async () => ({ inputHash: hash, finishedAt: daysAgo(1.1) }) })
    expect(await curate(old.deps)).toBe('succeeded')
    const changed = setup({
      lastSucceeded: async () => ({ inputHash: hash, finishedAt: daysAgo(0.1) }),
      loadItems: async () => [item(1), item(2, { status: 'In Progress', progress: '40%' })],
    })
    expect(await curate(changed.deps)).toBe('succeeded')
    expect(changed.state.runs[0].inputHash).not.toBe(hash)
  })

  it('holds a recently dismissed item out and lets an old dismissal back in', async () => {
    const { deps, state } = setup({
      loadItems: async () => [
        item(1), item(2), item(3, { shortlist_dismissed_at: daysAgo(5) }),
        item(4, { shortlist_dismissed_at: daysAgo(30) }), item(5, { pinned_at: daysAgo(1) }),
      ],
    })
    await curate(deps)
    const queue = state.calls[0].files['queue.jsonl'].trimEnd().split('\n').map((l) => JSON.parse(l))
    expect(queue.map((c: { id: number }) => c.id)).toEqual([1, 2, 4, 5])
    expect(queue.find((c: { id: number }) => c.id === 4)).toMatchObject({ dismissedOn: daysAgo(30).slice(0, 10), pinned: false })
    expect(queue.find((c: { id: number }) => c.id === 5)).toMatchObject({ pinned: true, dismissedOn: null })
    expect(state.runs[0].itemsConsidered).toBe(4)
  })

  it('records a failed run and keeps the old notes when the picks are unusable', async () => {
    const { deps, state } = setup({}, { ...good, picksFile: null })
    expect(await curate(deps)).toBe('failed')
    expect(state.runs).toHaveLength(1)
    expect(state.runs[0]).toMatchObject({ status: 'failed', picks: [], error: 'the agent wrote no picks.json' })
    expect(state.saved).toEqual([])
    expect(state.logs.at(-1)).toBe('FAILED: the agent wrote no picks.json')
    expect(state.alerts).toEqual([{ message: 'queue curation failed', extra: { kind: 'no_usable_picks' } }])
  })

  it('records a failed run with a short clean message when the agent crashes', async () => {
    const { deps, state } = setup({}, new Error(`claude timed out\n\u001b[31m${'x'.repeat(400)}`))
    expect(await curate(deps)).toBe('failed')
    const error = state.runs[0].error!
    expect(error.startsWith('claude timed out [31m')).toBe(true)
    expect(error.length).toBeLessThanOrEqual(200)
    expect(state.alerts[0].extra).toEqual({ kind: 'agent_failed' })
    expect(state.runs[0].toolSummary).toBeNull()
  })

  it('fails loudly when a good run cannot be saved', async () => {
    const { deps, state } = setup({ recordRun: async () => { throw new Error('db down') } })
    expect(await curate(deps)).toBe('failed')
    expect(state.saved).toEqual([])
    expect(state.logs.at(-1)).toBe('FAILED: could not save the run: db down')
    expect(state.alerts[0]).toEqual({ message: 'queue curation failed', extra: { kind: 'save_failed' } })
  })

  it('still succeeds when notes or pruning fail', async () => {
    const { deps, state } = setup({ saveMemory: async () => { throw new Error('nope') }, prune: async () => { throw new Error('nope') } })
    expect(await curate(deps)).toBe('succeeded')
    expect(state.logs.some((l) => l.startsWith('warning: notes not saved'))).toBe(true)
  })

  it('does nothing at all during quiet hours', async () => {
    let read = false
    const { deps, state } = setup({ now: () => new Date('2026-11-10T08:00:00Z'), loadItems: async () => { read = true; return [] } })
    expect(await curate(deps)).toBe('skipped')
    expect(read).toBe(false)
    expect(state.calls).toEqual([])
    expect(state.logs.at(-1)).toBe('skipped: quiet hours (10 pm to 5 am)')
  })

  it('does nothing on an empty queue', async () => {
    const { deps, state } = setup({ loadItems: async () => [] })
    expect(await curate(deps)).toBe('skipped')
    expect(state.calls).toEqual([])
    expect(state.runs).toEqual([])
  })

  it('does not retry the same input for 6 hours after it failed', async () => {
    const first = setup()
    await curate(first.deps)
    const hash = first.state.runs[0].inputHash
    const recent = setup({ lastFailed: async () => ({ inputHash: hash, finishedAt: daysAgo(1 / 24) }) })
    expect(await curate(recent.deps)).toBe('skipped')
    expect(recent.state.calls).toEqual([])
    expect(recent.state.logs.at(-1)).toMatch(/^skipped: this input failed 1\.0 h ago; retrying after 6 h/)
    const old = setup({ lastFailed: async () => ({ inputHash: hash, finishedAt: daysAgo(7 / 24) }) })
    expect(await curate(old.deps)).toBe('succeeded')
    const other = setup({ lastFailed: async () => ({ inputHash: 'different', finishedAt: daysAgo(1 / 24) }) })
    expect(await curate(other.deps)).toBe('succeeded')
  })

  it('says how the session ended when it left no picks', async () => {
    const stream = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true })
    const { deps, state } = setup({}, { stream, picksFile: null, memory: null })
    await curate(deps)
    expect(state.runs[0].error).toBe('the agent wrote no picks.json (claude ended: error_max_turns)')
    // The free text stays in the database and the local log; the alert, which
    // can end up in an alert, carries only a fixed category.
    expect(state.alerts).toEqual([{ message: 'queue curation failed', extra: { kind: 'no_usable_picks' } }])
  })

  it('reports a crash while building the input, not just a read failure', async () => {
    const { deps, state } = setup({ loadItems: async () => [{ ...item(1), sources: null as never }] })
    expect(await curate(deps)).toBe('failed')
    expect(state.logs.at(-1)).toMatch(/^FAILED: could not prepare the run: /)
    expect(state.alerts).toEqual([{ message: 'queue curation failed', extra: { kind: 'prepare_failed' } }])
  })
})

describe('inQuietHours (10 pm to 5 am Chicago)', () => {
  // Chicago is UTC-6 in November (CST) and UTC-5 in July (CDT).
  const at = (iso: string) => inQuietHours(new Date(iso))
  it('is quiet from 22:00 up to, not including, 05:00', () => {
    expect(at('2026-11-10T04:00:00Z')).toBe(true)   // 22:00 CST
    expect(at('2026-11-10T06:30:00Z')).toBe(true)   // 00:30
    expect(at('2026-11-10T10:59:00Z')).toBe(true)   // 04:59
  })
  it('runs from 05:00 through 21:59', () => {
    expect(at('2026-11-10T11:00:00Z')).toBe(false)  // 05:00
    expect(at('2026-11-10T11:45:00Z')).toBe(false)  // 05:45, the morning run
    expect(at('2026-11-10T03:45:00Z')).toBe(false)  // 21:45, the last run
  })
  it('follows daylight saving time', () => {
    expect(at('2026-07-10T10:45:00Z')).toBe(false)  // 05:45 CDT
    expect(at('2026-07-10T03:00:00Z')).toBe(true)   // 22:00 CDT
  })
})

