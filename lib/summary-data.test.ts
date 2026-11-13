import { describe, it, expect } from 'vitest'
import { parseSummaryOutput, summaryDataFromDb, isBackCatalog, NO_ACCESS_PREFIX } from './summary-data'

const valid = { one_liner: 'Core claim.', bullets: ['a', 'b', 'c', 'd'], source_access: 'full_text' }

describe('parseSummaryOutput', () => {
  it('parses a valid object', () => {
    expect(parseSummaryOutput(JSON.stringify(valid))).toEqual(valid)
  })

  it('strips a ```json fence and trims fields', () => {
    const text = '```json\n' + JSON.stringify({ ...valid, one_liner: '  Core claim.  ', bullets: [' a ', 'b'] }) + '\n```'
    expect(parseSummaryOutput(text)).toEqual({ ...valid, bullets: ['a', 'b'] })
  })

  it('throws on non-JSON text', () => {
    expect(() => parseSummaryOutput('I have enough to write a blurb.')).toThrow('not valid JSON')
  })

  it('throws when one_liner is empty', () => {
    expect(() => parseSummaryOutput(JSON.stringify({ ...valid, one_liner: '  ' }))).toThrow('failed validation')
  })

  it('throws on an unknown source_access', () => {
    expect(() => parseSummaryOutput(JSON.stringify({ ...valid, source_access: 'partial' }))).toThrow('failed validation')
  })

  it('throws on more than 6 bullets', () => {
    expect(() => parseSummaryOutput(JSON.stringify({ ...valid, bullets: Array(7).fill('x') }))).toThrow('failed validation')
  })

  it('rejects 0 bullets for a normal one-liner', () => {
    expect(() => parseSummaryOutput(JSON.stringify({ ...valid, bullets: [] }))).toThrow('failed validation')
  })

  it('accepts 0 bullets when the one-liner is the no-access line', () => {
    const noAccess = { one_liner: `${NO_ACCESS_PREFIX}: a 2019 TAL episode`, bullets: [], source_access: 'descriptions_only' }
    expect(parseSummaryOutput(JSON.stringify(noAccess))).toEqual(noAccess)
  })

  it('drops blank bullets before counting', () => {
    expect(() => parseSummaryOutput(JSON.stringify({ ...valid, bullets: ['', '  '] }))).toThrow('failed validation')
  })
})

describe('summaryDataFromDb', () => {
  it('maps a v2 row to camelCase', () => {
    expect(summaryDataFromDb({ ...valid, model: 'claude-opus-5-5', version: 2 })).toEqual({
      oneLiner: 'Core claim.', bullets: ['a', 'b', 'c', 'd'], sourceAccess: 'full_text', model: 'claude-opus-5-5',
    })
  })

  it('returns null for null, non-objects, wrong version, or missing fields', () => {
    expect(summaryDataFromDb(null)).toBeNull()
    expect(summaryDataFromDb('text')).toBeNull()
    expect(summaryDataFromDb({ ...valid, model: 'm', version: 3 })).toBeNull()
    expect(summaryDataFromDb({ one_liner: 'x', model: 'm', version: 2 })).toBeNull()
  })
})

describe('isBackCatalog', () => {
  const created = '2026-09-23T14:15:00Z'
  it('is true when published more than 90 days before creation', () => {
    expect(isBackCatalog('1996-11-17T12:00:00Z', created)).toBe(true)
  })
  it('is false at exactly 90 days', () => {
    expect(isBackCatalog('2026-06-25T14:15:00Z', created)).toBe(false)
  })
  it('is false for recent items', () => {
    expect(isBackCatalog('2026-09-20T00:00:00Z', created)).toBe(false)
  })
  it('is false for null or unparseable dates', () => {
    expect(isBackCatalog(null, created)).toBe(false)
    expect(isBackCatalog(undefined, created)).toBe(false)
    expect(isBackCatalog('not a date', created)).toBe(false)
  })
  it('honors a custom max age', () => {
    expect(isBackCatalog('2026-09-01T00:00:00Z', created, 7)).toBe(true)
  })
})
