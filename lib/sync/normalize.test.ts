import { describe, it, expect } from 'vitest'
import { isProgressIncrease, normalizeProgress, normalizeStatus } from './normalize'

describe('normalizeProgress', () => {
  describe('percentage strings', () => {
    it('should handle integer percentages', () => {
      expect(normalizeProgress('65')).toBe('65')
      expect(normalizeProgress('0')).toBe('0')
      expect(normalizeProgress('100')).toBe('100')
    })

    it('should strip % suffix', () => {
      expect(normalizeProgress('65%')).toBe('65')
      expect(normalizeProgress('100%')).toBe('100')
      expect(normalizeProgress('0%')).toBe('0')
    })

    it('should handle whitespace', () => {
      expect(normalizeProgress('  65  ')).toBe('65')
      expect(normalizeProgress('65 %')).toBe('65')
      expect(normalizeProgress(' 65% ')).toBe('65')
    })
  })

  describe('decimal values', () => {
    it('should round decimal percentages', () => {
      expect(normalizeProgress('65.7')).toBe('66')
      expect(normalizeProgress('65.4')).toBe('65')
      expect(normalizeProgress('65.5')).toBe('66')
    })

    it('should convert 0-1 fractions to percentages', () => {
      expect(normalizeProgress('0.65')).toBe('65')
      expect(normalizeProgress('0.5')).toBe('50')
      expect(normalizeProgress('0.99')).toBe('99')
      expect(normalizeProgress('0.01')).toBe('1')
    })

    it('should handle edge cases for fractions', () => {
      // 0 and 1 are NOT treated as fractions (could be 0% or 1%)
      expect(normalizeProgress('0')).toBe('0')
      expect(normalizeProgress('1')).toBe('1')
      // But 0.0 should round to 0
      expect(normalizeProgress('0.0')).toBe('0')
    })
  })

  describe('clamping', () => {
    it('should clamp values above 100', () => {
      expect(normalizeProgress('150')).toBe('100')
      expect(normalizeProgress('999')).toBe('100')
    })

    it('should clamp negative values to 0', () => {
      expect(normalizeProgress('-10')).toBe('0')
      expect(normalizeProgress('-0.5')).toBe('0')
    })
  })

  describe('invalid inputs', () => {
    it('should return null for empty strings', () => {
      expect(normalizeProgress('')).toBeNull()
      expect(normalizeProgress('   ')).toBeNull()
    })

    it('should return null for undefined/null', () => {
      expect(normalizeProgress(undefined)).toBeNull()
      expect(normalizeProgress(null)).toBeNull()
    })

    it('should return null for non-numeric strings', () => {
      expect(normalizeProgress('abc')).toBeNull()
      expect(normalizeProgress('fifty')).toBeNull()
      expect(normalizeProgress('N/A')).toBeNull()
    })
  })
})

describe('normalizeStatus', () => {
  describe('completed status', () => {
    it('should normalize completed variations', () => {
      expect(normalizeStatus('Completed')).toBe('Completed')
      expect(normalizeStatus('completed')).toBe('Completed')
      expect(normalizeStatus('COMPLETED')).toBe('Completed')
    })

    it('should normalize finished variations', () => {
      expect(normalizeStatus('finished')).toBe('Completed')
      expect(normalizeStatus('Finished')).toBe('Completed')
    })

    it('should normalize done variations', () => {
      expect(normalizeStatus('done')).toBe('Completed')
      expect(normalizeStatus('Done')).toBe('Completed')
    })
  })

  describe('in progress status', () => {
    it('should normalize in progress variations', () => {
      expect(normalizeStatus('In Progress')).toBe('In Progress')
      expect(normalizeStatus('in progress')).toBe('In Progress')
      expect(normalizeStatus('IN PROGRESS')).toBe('In Progress')
    })

    it('should normalize underscore and no-space variations', () => {
      expect(normalizeStatus('in_progress')).toBe('In Progress')
      expect(normalizeStatus('inprogress')).toBe('In Progress')
    })

    it('should normalize activity-based status words', () => {
      expect(normalizeStatus('playing')).toBe('In Progress')
      expect(normalizeStatus('listening')).toBe('In Progress')
      expect(normalizeStatus('reading')).toBe('In Progress')
    })
  })

  describe('invalid inputs', () => {
    it('should return null for empty/undefined', () => {
      expect(normalizeStatus('')).toBeNull()
      expect(normalizeStatus(undefined)).toBeNull()
      expect(normalizeStatus(null)).toBeNull()
    })

    it('should return null for unknown status values', () => {
      expect(normalizeStatus('paused')).toBeNull()
      expect(normalizeStatus('queued')).toBeNull()
      expect(normalizeStatus('unknown')).toBeNull()
    })
  })

  describe('whitespace handling', () => {
    it('should trim whitespace', () => {
      expect(normalizeStatus('  Completed  ')).toBe('Completed')
      expect(normalizeStatus('  in progress  ')).toBe('In Progress')
    })
  })
})

describe('isProgressIncrease', () => {
  // Cross-source high-water mark (#192): an item can have both a Spotify and a
  // Substack source (AI-voiced podcast of a post). Progress must only ever
  // rise, so the hourly Spotify sync and daily Substack harvest don't fight.
  it('returns true when incoming is numerically greater', () => {
    expect(isProgressIncrease('63', '55')).toBe(true)
  })

  it('returns false when incoming is lower', () => {
    expect(isProgressIncrease('20', '80')).toBe(false)
  })

  it('returns false when equal (no pointless write)', () => {
    expect(isProgressIncrease('55', '55')).toBe(false)
  })

  it('compares numerically, not lexicographically', () => {
    expect(isProgressIncrease('9', '63')).toBe(false)
    expect(isProgressIncrease('100', '9')).toBe(true)
  })

  it('returns false when incoming is null', () => {
    expect(isProgressIncrease(null, '50')).toBe(false)
  })

  it('returns true when current is null, undefined, or empty', () => {
    expect(isProgressIncrease('10', null)).toBe(true)
    expect(isProgressIncrease('10', undefined)).toBe(true)
    expect(isProgressIncrease('10', '')).toBe(true)
  })

  it('returns true when current is non-numeric junk', () => {
    expect(isProgressIncrease('10', 'abc')).toBe(true)
  })

  it('returns false when incoming is non-numeric', () => {
    expect(isProgressIncrease('abc', '10')).toBe(false)
  })
})
