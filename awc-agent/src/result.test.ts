// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { RESULT_SCHEMA, boundError, coverageWarning, errorText, parseClaudeResult } from './result'

const line = (o: unknown) => JSON.stringify(o)
const FENCE = '`'.repeat(3)

describe('parseClaudeResult', () => {
  it('prefers structured_output from the final result event', () => {
    const stream = [
      line({ type: 'assistant' }),
      line({ type: 'result', subtype: 'success', structured_output: { outcome: 'generating', path: 'url', episode_title: 'T', credits: 9, error: null } }),
    ].join('\n')
    expect(parseClaudeResult(stream)).toEqual({ outcome: 'generating', path: 'url', episodeTitle: 'T', credits: 9 })
  })

  it('falls back to a fenced JSON object in the result text', () => {
    const text = `Done.\n${FENCE}json\n{"outcome":"failed","path":"script","episode_title":null,"credits":null,"error":"paywall unreadable"}\n${FENCE}`
    expect(parseClaudeResult(line({ type: 'result', subtype: 'success', result: text })))
      .toEqual({ outcome: 'failed', path: 'script', error: 'paywall unreadable' })
  })

  it('falls back to a bare JSON object in the result text', () => {
    const text = 'Result: {"outcome":"generating","path":"script","episode_title":"Ep","credits":null,"error":null}'
    expect(parseClaudeResult(line({ type: 'result', subtype: 'success', result: text })))
      .toEqual({ outcome: 'generating', path: 'script', episodeTitle: 'Ep', credits: null })
  })

  it('ignores non-JSON noise lines in the stream', () => {
    const stream = ['warning: something', line({ type: 'result', subtype: 'success', structured_output: { outcome: 'failed', path: null, episode_title: null, credits: null, error: 'x' } })].join('\n')
    expect(parseClaudeResult(stream)).toEqual({ outcome: 'failed', path: null, error: 'x' })
  })

  it('fails closed on a missing or malformed result', () => {
    expect(parseClaudeResult('')).toEqual({ outcome: 'failed', path: null, error: 'agent produced no result' })
    expect(parseClaudeResult(line({ type: 'result', subtype: 'error_max_turns' })))
      .toEqual({ outcome: 'failed', path: null, error: 'agent ended: error_max_turns' })
    expect(parseClaudeResult(line({ type: 'result', subtype: 'success', structured_output: { outcome: 'generating', path: 'url' } })))
      .toEqual({ outcome: 'failed', path: null, error: 'agent result missing episode_title' })
    expect(parseClaudeResult(line({ type: 'result', subtype: 'success', structured_output: { outcome: 'generating', path: 'tape', episode_title: 'T' } })))
      .toEqual({ outcome: 'failed', path: null, error: 'agent result missing path' })
    expect(parseClaudeResult(line({ type: 'result', subtype: 'success', result: 'no json here' })))
      .toEqual({ outcome: 'failed', path: null, error: 'agent produced no result' })
  })
})

// #363: conversion 18 recorded a 783-word summary of a 3,542-word article and
// reported a clean success. AWC's price is the only signal the daemon has.
describe('reported_words in the agent result', () => {
  const result = (reported_words: unknown) => line({ type: 'result', subtype: 'success', structured_output: { outcome: 'generating', path: 'script', episode_title: 'T', credits: 5, reported_words, error: null } })
  it('is required by the schema', () => {
    expect(RESULT_SCHEMA.required).toContain('reported_words')
  })
  it('is carried on a generating result', () => {
    expect(parseClaudeResult(result(3542))).toEqual({ outcome: 'generating', path: 'script', episodeTitle: 'T', credits: 5, reportedWords: 3542 })
  })
  it('is dropped when null or not a positive number', () => {
    for (const bad of [null, 'lots', 0, -3]) {
      expect(parseClaudeResult(result(bad))).toEqual({ outcome: 'generating', path: 'script', episodeTitle: 'T', credits: 5 })
    }
  })
})

describe('coverageWarning', () => {
  it('flags the 5-credit summary of a 3,542-word article', () => {
    expect(coverageWarning({ credits: 5, reportedWords: 3542, wordCount: 1483 }))
      .toBe('short episode: 5 credits for about 3,542 words')
  })
  // Complete scripts cost about 175 words a credit (runs 3, 13, 16).
  it.each([
    [32, 5744], [88, 15591], [16, 2778],
  ])('does not flag a complete run: %i credits for %i words', (credits, words) => {
    expect(coverageWarning({ credits, reportedWords: words, wordCount: null })).toBeNull()
  })
  it('flags on the item word count when AWC reported no length, and uses the larger of the two', () => {
    expect(coverageWarning({ credits: 5, reportedWords: null, wordCount: 1483 })).toBe('short episode: 5 credits for about 1,483 words')
    expect(coverageWarning({ credits: 5, reportedWords: 1483, wordCount: 3542 })).toBe('short episode: 5 credits for about 3,542 words')
  })
  it('allows exactly 65% of length / 150, flags just under it', () => {
    expect(coverageWarning({ credits: 13, reportedWords: 3000, wordCount: null })).toBeNull()
    expect(coverageWarning({ credits: 12, reportedWords: 3000, wordCount: null })).toBe('short episode: 12 credits for about 3,000 words')
  })
  it('stays quiet when credits or length are unknown', () => {
    expect(coverageWarning({ credits: null, reportedWords: 3542, wordCount: 1483 })).toBeNull()
    expect(coverageWarning({ credits: 5, reportedWords: null, wordCount: null })).toBeNull()
  })
})

describe('boundError', () => {
  it('flattens control characters and caps length at 200', () => {
    expect(boundError('line1\nline2\t\u0007x')).toBe('line1 line2 x')
    const long = boundError('a'.repeat(500))
    expect(long.length).toBe(200)
    expect(long.endsWith('…')).toBe(true)
  })
  it('is applied to agent-reported failures', () => {
    const stream = JSON.stringify({ type: 'result', subtype: 'success', structured_output: { outcome: 'failed', path: null, episode_title: null, credits: null, error: 'x\n'.repeat(300) } })
    const r = parseClaudeResult(stream)
    expect(r.outcome === 'failed' && r.error.length).toBeLessThanOrEqual(200)
    expect(r.outcome === 'failed' && r.error.includes('\n')).toBe(false)
  })
})

// #335: supabase-js rejects with a plain PostgrestError-shaped object, and
// String() of that is "[object Object]" — the cause of #332/#333 was lost.
describe('errorText', () => {
  it('uses the message of an Error', () => {
    expect(errorText(new Error('db down'))).toBe('db down')
    expect(errorText(new TypeError('fetch failed'))).toBe('TypeError: fetch failed')
  })
  it('joins message, code, details and hint of a PostgrestError-shaped object', () => {
    expect(errorText({ message: 'TypeError: fetch failed', code: '', details: 'connect ETIMEDOUT', hint: null }))
      .toBe('TypeError: fetch failed (details: connect ETIMEDOUT)')
    expect(errorText({ message: 'JWT expired', code: 'PGRST301' })).toBe('JWT expired (code: PGRST301)')
  })
  it('passes strings through and JSON-encodes other objects', () => {
    expect(errorText('boom')).toBe('boom')
    expect(errorText({ status: 503 })).toBe('{"status":503}')
  })
  it('keeps only the first line of a stack-trace details, and skips details that just repeat the message', () => {
    const details = 'TypeError: fetch failed\n    at node:internal/deps/undici:1:1\n    at /Users/x/app.js:2:2'
    expect(errorText({ message: 'TypeError: fetch failed', details, hint: 'Request was aborted' }))
      .toBe('TypeError: fetch failed (hint: Request was aborted)')
    expect(errorText({ message: 'fetch failed', details: 'Caused by: connect ETIMEDOUT\n  at x' }))
      .toBe('fetch failed (details: Caused by: connect ETIMEDOUT)')
  })
  it('keeps the Error name and its cause (where fetch puts the network reason)', () => {
    expect(errorText(new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })))
      .toBe('TypeError: fetch failed (cause: connect ECONNREFUSED)')
    expect(errorText(new Error(''))).toBe('Error')
  })
  it('is bounded to one short line', () => {
    const out = errorText({ message: 'x'.repeat(500) + '\nsecond line' })
    expect(out.length).toBeLessThanOrEqual(200)
    expect(out).not.toContain('\n')
  })
  it('never throws and never returns [object Object]', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(errorText(null)).toBe('null')
    expect(errorText(undefined)).toBe('undefined')
    expect(errorText(circular)).not.toContain('[object Object]')
    expect(errorText({ toJSON: () => undefined })).toEqual(expect.any(String))
  })
})
