import { describe, it, expect } from 'vitest'
import { serializeError } from './serialize-error'

describe('serializeError', () => {
  describe('Error instances', () => {
    it('serializes name + message', () => {
      const r = serializeError(new TypeError('boom'))
      expect(r.message).toBe('TypeError: boom')
      expect(r.details).toBeNull()
    })

    it('walks Error.cause chain so the root cause lands in error_message', () => {
      // Real-world shape: TypeError("fetch failed") wraps HeadersOverflowError.
      // Without cause-walking, "TypeError: fetch failed" by itself would lose
      // the actual diagnostic ("headers exceeded limit").
      const root = new RangeError('headers too big')
      const wrapped = new TypeError('fetch failed', { cause: root })
      const r = serializeError(wrapped)
      expect(r.message).toBe(
        'TypeError: fetch failed\nCaused by: RangeError: headers too big'
      )
      expect(r.details).toBeNull()
    })

    it('walks multi-level cause chains', () => {
      const e1 = new Error('level 1')
      const e2 = new Error('level 2', { cause: e1 })
      const e3 = new Error('level 3', { cause: e2 })
      const r = serializeError(e3)
      expect(r.message).toContain('level 3')
      expect(r.message).toContain('level 2')
      expect(r.message).toContain('level 1')
    })

    it('handles non-Error cause values', () => {
      const wrapped = new Error('wrapped', { cause: 'string cause' })
      const r = serializeError(wrapped)
      expect(r.message).toBe('Error: wrapped\nCaused by: string cause')
    })
  })

  describe('PostgrestError-shaped objects (supabase-js)', () => {
    it('extracts message + hint + details, dropping empty code', () => {
      // This is the literal shape the user observed in the failed Spotify sync —
      // empty code, hint with the diagnostic, details with the cause chain.
      const err = {
        message: 'TypeError: fetch failed',
        details: 'TypeError: fetch failed\n\nCaused by: HeadersOverflowError',
        hint: 'HTTP headers exceeded server limits (typically 16KB).',
        code: '',
      }
      const r = serializeError(err)
      expect(r.message).toBe('TypeError: fetch failed')
      expect(r.details).toEqual({
        hint: 'HTTP headers exceeded server limits (typically 16KB).',
        details: 'TypeError: fetch failed\n\nCaused by: HeadersOverflowError',
      })
    })

    it('preserves a non-empty code', () => {
      const r = serializeError({
        message: 'duplicate key value violates unique constraint',
        code: '23505',
        hint: 'Use ON CONFLICT',
      })
      expect(r.message).toBe('duplicate key value violates unique constraint')
      expect(r.details).toEqual({
        code: '23505',
        hint: 'Use ON CONFLICT',
      })
    })

    it('returns null details when only message is present', () => {
      const r = serializeError({ message: 'just a message' })
      expect(r.message).toBe('just a message')
      expect(r.details).toBeNull()
    })

    it('drops detail fields that are empty strings', () => {
      const r = serializeError({ message: 'm', code: '', hint: '', details: '' })
      expect(r.details).toBeNull()
    })
  })

  describe('fallbacks', () => {
    it('returns "Unknown error" for null/undefined', () => {
      expect(serializeError(null).message).toBe('Unknown error')
      expect(serializeError(undefined).message).toBe('Unknown error')
    })

    it('returns the string for a string error', () => {
      expect(serializeError('a string error').message).toBe('a string error')
    })

    it('returns "Unknown error" for the empty string', () => {
      expect(serializeError('').message).toBe('Unknown error')
    })

    it('stringifies numbers', () => {
      expect(serializeError(42).message).toBe('42')
    })

    it('JSON-stringifies plain objects without a message field', () => {
      expect(serializeError({ foo: 'bar' }).message).toBe('{"foo":"bar"}')
    })
  })
})
