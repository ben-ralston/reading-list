import { describe, it, expect } from 'vitest'
import { buildDurationFill, buildSourceProgressFill } from './sync-updates'

describe('buildDurationFill', () => {
  it('fills duration when the item has none stored', () => {
    expect(buildDurationFill(50, 3600, null)).toEqual({ id: 50, duration_seconds: 3600 })
  })

  it('never overwrites an existing duration', () => {
    expect(buildDurationFill(50, 3600, 1800)).toBeNull()
  })

  it.each([0, null, undefined])('returns null when the incoming duration is %j', (incoming) => {
    expect(buildDurationFill(50, incoming, null)).toBeNull()
  })
})

describe('buildSourceProgressFill', () => {
  it('fills when the stored per-source value is null', () => {
    expect(buildSourceProgressFill({ id: 9, progress: null }, '45')).toEqual({
      sourceId: 9,
      progress: 45,
    })
  })

  it('fills when the value changed', () => {
    expect(buildSourceProgressFill({ id: 9, progress: 40 }, '45')).toEqual({
      sourceId: 9,
      progress: 45,
    })
  })

  it('fills a REGRESSION — last-seen semantics, not high-water', () => {
    expect(buildSourceProgressFill({ id: 9, progress: 90 }, '30')).toEqual({
      sourceId: 9,
      progress: 30,
    })
  })

  it('skips when the stored value already matches (hourly churn guard)', () => {
    expect(buildSourceProgressFill({ id: 9, progress: 45 }, '45')).toBeNull()
  })

  it('skips when there is no cached source row', () => {
    expect(buildSourceProgressFill(null, '45')).toBeNull()
  })

  it('skips when incoming progress is null', () => {
    expect(buildSourceProgressFill({ id: 9, progress: 40 }, null)).toBeNull()
  })
})
