import { describe, it, expect } from 'vitest'
import { activeSheetFilterCount } from './sheet-filter-count'

describe('activeSheetFilterCount', () => {
  it('counts media as one and each selected author/status as one', () => {
    expect(activeSheetFilterCount('all', [], [])).toBe(0)
    expect(activeSheetFilterCount('audio', [], [])).toBe(1)
    expect(activeSheetFilterCount('audio', ['in-progress', 'suggested'], ['Jane Doe'])).toBe(4)
  })
})
