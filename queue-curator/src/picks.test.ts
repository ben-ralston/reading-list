// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { parsePicks, parsePicksFile } from './picks'

const ids = new Set([1, 2, 3, ...Array.from({ length: 40 }, (_, i) => 100 + i)])
const stream = (result: object) => [
  JSON.stringify({ type: 'system', subtype: 'init' }),
  'not json noise',
  JSON.stringify({ type: 'result', ...result }),
].join('\n')
const structured = (picks: unknown) => stream({ subtype: 'success', structured_output: { picks } })

describe('parsePicks', () => {
  it('reads structured output and blanks empty reasons', () => {
    const r = parsePicks(structured([{ id: 1, reason: 'New; you finish these' }, { id: 2, reason: '' }]), ids)
    expect(r).toEqual({ ok: true, picks: [{ id: 1, reason: 'New; you finish these' }, { id: 2, reason: null }], dropped: [] })
  })

  it('falls back to fenced JSON in the result text', () => {
    const text = 'Here you go:\n```json\n{"picks":[{"id":3,"reason":"Short"}]}\n```'
    const r = parsePicks(stream({ subtype: 'success', result: text }), ids)
    expect(r).toMatchObject({ ok: true, picks: [{ id: 3, reason: 'Short' }] })
  })

  it('drops unknown, repeated and malformed entries but keeps order', () => {
    const r = parsePicks(structured([
      { id: 2, reason: 'a' }, { id: 999, reason: 'b' }, { id: 2, reason: 'c' },
      { id: '3', reason: 'd' }, 'junk', { id: 1.5, reason: 'e' }, { id: 1, reason: 'f' },
    ]), ids)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.picks.map(p => p.id)).toEqual([2, 1])
    expect(r.dropped).toHaveLength(5)
  })

  it('keeps at most 25', () => {
    const r = parsePicks(structured(Array.from({ length: 30 }, (_, i) => ({ id: 100 + i, reason: '' }))), ids)
    expect(r.ok && r.picks.length).toBe(25)
  })

  it('nulls an over-length reason and cleans control characters', () => {
    const r = parsePicks(structured([{ id: 1, reason: 'x'.repeat(61) }, { id: 2, reason: 'two\nlines\u0007 here' }, { id: 3, reason: 42 }]), ids)
    expect(r.ok && r.picks).toEqual([{ id: 1, reason: null }, { id: 2, reason: 'two lines here' }, { id: 3, reason: null }])
  })

  it('fails closed', () => {
    expect(parsePicks(stream({ subtype: 'error_max_turns' }), ids)).toEqual({ ok: false, error: 'claude ended: error_max_turns' })
    expect(parsePicks('garbage', ids).ok).toBe(false)
    expect(parsePicks(structured([{ id: 999, reason: '' }]), ids).ok).toBe(false)
    expect(parsePicks(structured('nope'), ids).ok).toBe(false)
    expect(parsePicks(stream({ subtype: 'success', result: 'no json here' }), ids).ok).toBe(false)
  })

  it('strips C1, bidi and zero-width characters from reasons', () => {
    const r = parsePicks(structured([{ id: 1, reason: 'ok\u202e\u009b31m\u200b red' }]), ids)
    expect(r.ok && r.picks[0].reason).toBe('ok 31m red')
  })
})

describe('parsePicksFile', () => {
  it('validates a picks.json the agent wrote', () => {
    expect(parsePicksFile('{"picks":[{"id":2,"reason":"Short"},{"id":999,"reason":""}]}', ids)).toEqual({
      ok: true, picks: [{ id: 2, reason: 'Short' }], dropped: ['id 999 is not in the queue'],
    })
  })

  it('fails closed on a missing or broken file', () => {
    expect(parsePicksFile(null, ids)).toEqual({ ok: false, error: 'the agent wrote no picks.json' })
    expect(parsePicksFile('{"picks": [', ids)).toEqual({ ok: false, error: 'picks.json is not valid JSON' })
    expect(parsePicksFile('[]', ids).ok).toBe(false)
  })
})

