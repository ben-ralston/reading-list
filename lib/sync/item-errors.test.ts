import { describe, expect, it } from 'vitest'
import { createItemErrorCollector } from './item-errors'

describe('createItemErrorCollector (#337)', () => {
  it('starts empty', () => {
    const collector = createItemErrorCollector()
    expect(collector.count).toBe(0)
    expect(collector.summary()).toEqual({ itemErrors: 0, codes: [], samples: [] })
  })

  it('keeps the Postgres code from a PostgrestError-shaped failure', () => {
    const collector = createItemErrorCollector()
    collector.record('Some post', { message: 'deadlock detected', code: '40P01', details: 'x', hint: 'y' })
    expect(collector.summary()).toEqual({
      itemErrors: 1,
      codes: ['40P01'],
      samples: [{ title: 'Some post', code: '40P01', message: 'deadlock detected' }],
    })
  })

  it('records Error instances by name and message with no code', () => {
    const collector = createItemErrorCollector()
    collector.record('Fetch me', new TypeError('fetch failed'))
    expect(collector.summary().samples).toEqual([{ title: 'Fetch me', message: 'TypeError: fetch failed' }])
    expect(collector.summary().codes).toEqual([])
  })

  it('caps samples at three but keeps counting and collecting distinct codes', () => {
    const collector = createItemErrorCollector()
    for (let i = 1; i <= 5; i++) {
      collector.record(`Item ${i}`, { message: `boom ${i}`, code: i % 2 === 0 ? '57014' : '40P01' })
    }
    collector.record('Item 6', { message: 'new code', code: '53300' })
    const summary = collector.summary()
    expect(collector.count).toBe(6)
    expect(summary.itemErrors).toBe(6)
    expect(summary.samples.map((s) => s.title)).toEqual(['Item 1', 'Item 2', 'Item 3'])
    expect(summary.codes).toEqual(['40P01', '57014', '53300'])
  })

  it('bounds title and message length so the log event cannot be rejected as oversized', () => {
    const collector = createItemErrorCollector()
    collector.record('t'.repeat(500), { message: 'm'.repeat(5000), code: '08006' })
    const [sample] = collector.summary().samples
    expect(sample.title).toHaveLength(80)
    expect(sample.message).toHaveLength(300)
  })

  it('coerces a non-string title instead of throwing (untrusted JSON payloads)', () => {
    const collector = createItemErrorCollector()
    expect(() => collector.record(123, { message: 'boom' })).not.toThrow()
    expect(() => collector.record({ nested: true }, { message: 'boom' })).not.toThrow()
    expect(collector.summary().samples.map((s) => s.title)).toEqual(['123', '[object Object]'])
  })

  it('tolerates a missing or empty title', () => {
    const collector = createItemErrorCollector()
    collector.record(undefined, 'plain string failure')
    collector.record('', null)
    expect(collector.summary().samples).toEqual([
      { title: '', message: 'plain string failure' },
      { title: '', message: 'Unknown error' },
    ])
  })
})
