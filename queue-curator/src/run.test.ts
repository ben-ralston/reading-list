// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { runDryRun, type RunDeps } from './run'
import type { ItemRow } from './digest'

const item = (id: number, over: Partial<ItemRow> = {}): ItemRow => ({
  id, title: `Title ${id}`, author: 'Zvi', status: '', progress: null, published_on: '2026-11-01',
  created_at: '2026-11-02T00:00:00Z', status_changed_at: null, added_by: null,
  duration_seconds: 600, word_count: null, summary: null, sources: [], ...over,
})
const answer = (picks: unknown) => JSON.stringify({ type: 'result', subtype: 'success', structured_output: { picks } })

function deps(over: Partial<RunDeps>): { deps: RunDeps; lines: string[]; prompts: string[] } {
  const lines: string[] = []
  const prompts: string[] = []
  return {
    lines,
    prompts,
    deps: {
      loadItems: async () => [item(1), item(2, { status: 'In Progress', progress: '40%', author: null, duration_seconds: null })],
      loadHistory: async () => [],
      template: 'T {{TODAY}} {{INSTRUCTIONS}} {{DATA}}',
      instructions: 'listen',
      runClaude: async (prompt) => { prompts.push(prompt); return answer([{ id: 2, reason: 'Nearly done' }, { id: 1, reason: '' }]) },
      now: new Date('2026-11-09T12:00:00Z'),
      out: (line) => lines.push(line),
      ...over,
    },
  }
}

describe('runDryRun', () => {
  it('prints the picks in order with reasons only where given', async () => {
    const t = deps({})
    const result = await runDryRun(t.deps)
    expect(result).toEqual({ ok: true })
    expect(t.lines[0]).toBe(`2 candidates, prompt ${t.prompts[0].length} characters`)
    expect(t.lines).toContain('1. Title 2 — unknown [length unknown, In Progress 40%]')
    expect(t.lines).toContain('   Nearly done')
    expect(t.lines).toContain('2. Title 1 — Zvi [10 min, new]')
    expect(t.lines.filter((l) => l.startsWith('   '))).toHaveLength(1)
    expect(t.prompts[0]).toContain('2026-11-09')
  })

  it('reports dropped entries', async () => {
    const t = deps({ runClaude: async () => answer([{ id: 1, reason: '' }, { id: 77, reason: '' }]) })
    expect(await runDryRun(t.deps)).toEqual({ ok: true })
    expect(t.lines.some((l) => l.startsWith('dropped: ') && l.includes('77'))).toBe(true)
  })

  it('fails without printing picks when the answer is unusable', async () => {
    const t = deps({ runClaude: async () => 'garbage' })
    expect(await runDryRun(t.deps)).toEqual({ ok: false })
    expect(t.lines).toContain('failed: claude produced no result')
    expect(t.lines.some((l) => l.startsWith('1. '))).toBe(false)
  })

  it('fails on an empty queue without calling claude', async () => {
    let called = false
    const t = deps({ loadItems: async () => [], runClaude: async () => { called = true; return '' } })
    expect(await runDryRun(t.deps)).toEqual({ ok: false })
    expect(called).toBe(false)
  })

  it('prints untrusted titles and authors as one clean line', async () => {
    const hostile = 'Real\n2. Fake pick [5 min, new]\u001b]52;c;ZXZpbA==\u0007\u202e\u009b31m'
    const t = deps({
      loadItems: async () => [item(1, { title: hostile, author: 'A\nB' })],
      runClaude: async () => answer([{ id: 1, reason: '' }]),
    })
    await runDryRun(t.deps)
    const line = t.lines.find((l) => l.startsWith('1. '))!
    expect(line).toBe('1. Real 2. Fake pick [5 min, new] ]52;c;ZXZpbA== 31m — A B [10 min, new]')
    expect(t.lines.some((l) => /[\u0000-\u001f\u007f-\u009f\u202e]/.test(l))).toBe(false)
  })

  it('dates the prompt in Chicago time, not UTC', async () => {
    const t = deps({ now: new Date('2026-11-10T01:30:00Z') })
    await runDryRun(t.deps)
    expect(t.prompts[0]).toContain('T 2026-11-09 ')
  })
})
