import { describe, it, expect } from 'vitest'
import { bearerTokenMatches } from './bearer-auth'

describe('bearerTokenMatches (RLV-016)', () => {
  it('accepts the exact Bearer <secret> header', () => {
    expect(bearerTokenMatches('Bearer s3cr3t', 's3cr3t')).toBe(true)
  })

  it('rejects a wrong token', () => {
    expect(bearerTokenMatches('Bearer nope', 's3cr3t')).toBe(false)
  })

  it('rejects a token that is a prefix of the secret (length mismatch)', () => {
    expect(bearerTokenMatches('Bearer s3cr3', 's3cr3t')).toBe(false)
  })

  it('rejects a missing Authorization header', () => {
    expect(bearerTokenMatches(null, 's3cr3t')).toBe(false)
  })

  it('rejects when the secret is unset', () => {
    expect(bearerTokenMatches('Bearer anything', undefined)).toBe(false)
    expect(bearerTokenMatches('Bearer anything', '')).toBe(false)
  })

  it('rejects a header missing the Bearer scheme', () => {
    expect(bearerTokenMatches('s3cr3t', 's3cr3t')).toBe(false)
  })
})
