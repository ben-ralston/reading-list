import { describe, it, expect, vi } from 'vitest'
import { clockTime, fullDateTime, relativeTime } from './format-time'

const ISO = '2026-08-17T18:34:00Z'

describe('clockTime', () => {
  it('returns an em dash for null', () => {
    expect(clockTime(null)).toBe('—')
  })
  it('renders the clock time in the given zone with its abbreviation (#282)', () => {
    expect(clockTime(ISO, { timeZone: 'America/New_York' })).toBe('2:34 PM EDT')
  })
  it('labels a UTC rendering as UTC so it is never mistaken for local', () => {
    expect(clockTime(ISO, { timeZone: 'UTC' })).toBe('6:34 PM UTC')
  })
})

describe('fullDateTime', () => {
  it('returns an em dash for null', () => {
    expect(fullDateTime(null)).toBe('—')
  })
  it('renders date, time and zone abbreviation', () => {
    expect(fullDateTime(ISO, { timeZone: 'America/New_York' })).toBe('Aug 17, 2026, 2:34 PM EDT')
  })
})

describe('relativeTime', () => {
  it('returns an em dash for null', () => {
    expect(relativeTime(null)).toBe('—')
  })
})

describe('ICU whitespace normalization (#282 hydration safety)', () => {
  // Some ICU builds (e.g. Safari) put U+202F before AM/PM while Node emits a
  // plain space; SSR and browser output must still be byte-identical.
  it('clockTime folds a narrow no-break space to a plain space', () => {
    const spy = vi.spyOn(Date.prototype, 'toLocaleTimeString').mockReturnValue('2:34\u202fPM EDT')
    try {
      expect(clockTime(ISO)).toBe('2:34 PM EDT')
    } finally {
      spy.mockRestore()
    }
  })
  it('fullDateTime folds a narrow no-break space to a plain space', () => {
    const spy = vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('Aug 17, 2026, 2:34\u202fPM EDT')
    try {
      expect(fullDateTime(ISO)).toBe('Aug 17, 2026, 2:34 PM EDT')
    } finally {
      spy.mockRestore()
    }
  })
})
