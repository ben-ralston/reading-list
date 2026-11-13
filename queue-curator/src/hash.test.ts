// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { inputHash } from './hash'

const base = { files: { 'queue.jsonl': 'a', 'history.jsonl': 'b', 'instructions.md': 'c', 'memory.md': 'm1' }, prompt: 'p', model: 'opus', promptVersion: 1 }

describe('inputHash', () => {
  it('is a stable sha256 hex digest regardless of file order', () => {
    const reordered = { ...base, files: { 'memory.md': 'm1', 'instructions.md': 'c', 'history.jsonl': 'b', 'queue.jsonl': 'a' } }
    expect(inputHash(base)).toMatch(/^[0-9a-f]{64}$/)
    expect(inputHash(reordered)).toBe(inputHash(base))
  })

  it('ignores the notes file, which the agent rewrites every run', () => {
    expect(inputHash({ ...base, files: { ...base.files, 'memory.md': 'different' } })).toBe(inputHash(base))
  })

  it('changes with any other input', () => {
    const h = inputHash(base)
    expect(inputHash({ ...base, files: { ...base.files, 'queue.jsonl': 'a2' } })).not.toBe(h)
    expect(inputHash({ ...base, files: { ...base.files, 'instructions.md': 'c2' } })).not.toBe(h)
    expect(inputHash({ ...base, prompt: 'p2' })).not.toBe(h)
    expect(inputHash({ ...base, model: 'sonnet' })).not.toBe(h)
    expect(inputHash({ ...base, promptVersion: 2 })).not.toBe(h)
  })
})
