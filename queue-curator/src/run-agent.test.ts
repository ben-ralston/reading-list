// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { MAX_MEMORY_CHARS, runAgentDryRun, type AgentDeps, type AgentOutcome } from './run'
import type { ItemRow } from './digest'

const item = (id: number): ItemRow => ({
  id, title: `Title ${id}`, author: 'Zvi', status: '', progress: null, published_on: '2026-11-01',
  created_at: '2026-11-02T00:00:00Z', status_changed_at: null, added_by: null,
  duration_seconds: 600, word_count: null, summary: null, sources: [],
})
const fetchEvent = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebFetch', input: { url: 'https://example.com/p' } }] } })
const good: AgentOutcome = { stream: fetchEvent, picksFile: '{"picks":[{"id":2,"reason":"Read it; strong"},{"id":1,"reason":""}]}', memory: 'new notes' }

function setup(over: Partial<AgentDeps> = {}, outcome: AgentOutcome = good) {
  const lines: string[] = []
  const saved: string[] = []
  const calls: { prompt: string; files: Record<string, string> }[] = []
  const deps: AgentDeps = {
    loadItems: async () => [item(1), item(2)],
    loadHistory: async () => [{ title: 'Done', author: 'Zvi', status: 'Completed', status_changed_at: null }],
    template: 'Today {{TODAY}}; {{COUNT}} items; memory cap {{MEMORY_CHARS}}',
    instructions: 'listen',
    loadMemory: async () => 'old notes',
    saveMemory: async (text) => { saved.push(text) },
    runAgent: async (prompt, files) => { calls.push({ prompt, files }); return outcome },
    now: new Date('2026-11-10T01:30:00Z'),
    out: (line) => lines.push(line),
    ...over,
  }
  return { deps, lines, saved, calls }
}

describe('runAgentDryRun', () => {
  it('hands the agent the files and a filled prompt, then prints its picks', async () => {
    const t = setup()
    expect(await runAgentDryRun(t.deps)).toEqual({ ok: true })
    expect(t.calls[0].prompt).toBe(`Today 2026-11-09; 2 items; memory cap ${MAX_MEMORY_CHARS}`)
    expect(t.calls[0].files['memory.md']).toBe('old notes')
    expect(t.calls[0].files['instructions.md']).toBe('listen')
    expect(t.calls[0].files['queue.jsonl'].trimEnd().split('\n')).toHaveLength(2)
    expect(t.lines).toContain('1. Title 2 — Zvi [10 min, new]')
    expect(t.lines).toContain('   Read it; strong')
    expect(t.lines).toContain('2. Title 1 — Zvi [10 min, new]')
  })

  it('reports what the agent did and saves changed memory', async () => {
    const t = setup()
    await runAgentDryRun(t.deps)
    expect(t.lines).toContain('tools: WebFetch 1')
    expect(t.lines).toContain('fetched: https://example.com/p')
    expect(t.saved).toEqual(['new notes'])
    expect(t.lines).toContain('memory updated (9 characters)')
  })

  it('leaves memory alone when unchanged, missing, empty or over the cap', async () => {
    for (const memory of ['old notes', null, '   ', 'x'.repeat(MAX_MEMORY_CHARS + 1)]) {
      const t = setup({}, { ...good, memory })
      expect(await runAgentDryRun(t.deps)).toEqual({ ok: true })
      expect(t.saved).toEqual([])
    }
    const t = setup({}, { ...good, memory: 'x'.repeat(MAX_MEMORY_CHARS + 1) })
    await runAgentDryRun(t.deps)
    expect(t.lines.some((l) => l.startsWith('memory not saved: '))).toBe(true)
  })

  it('fails and keeps old memory when there are no usable picks', async () => {
    const t = setup({}, { ...good, picksFile: null })
    expect(await runAgentDryRun(t.deps)).toEqual({ ok: false })
    expect(t.lines).toContain('failed: the agent wrote no picks.json')
    expect(t.saved).toEqual([])
  })
})
