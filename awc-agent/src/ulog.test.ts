// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { createUlog } from './ulog'
describe('createUlog', () => {
  it('suppresses repeats of the same level+message within the interval', () => {
    let now = 0
    const send = vi.fn().mockResolvedValue(true)
    const ulog = createUlog({ send, nowMs: () => now, minIntervalMs: 60_000 })
    ulog.error('claim failed', { a: 1 })
    ulog.error('claim failed', { a: 2 })
    now = 61_000
    ulog.error('claim failed', { a: 3 })
    ulog.warn('claim failed')
    expect(send.mock.calls.map((c) => [c[0], c[2]])).toEqual([['error', { a: 1 }], ['error', { a: 3 }], ['warn', undefined]])
  })
  it('never throws when send rejects', () => {
    const ulog = createUlog({ send: vi.fn().mockRejectedValue(new Error('x')), nowMs: () => 0 })
    expect(() => ulog.error('boom')).not.toThrow()
  })
})
