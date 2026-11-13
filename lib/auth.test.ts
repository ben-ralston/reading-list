import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// lib/auth.ts validates the session secret at import time.
vi.hoisted(() => {
  process.env.AUTH_PASSWORD_SECRET ??= 'x'.repeat(32)
})

import { validatePassword } from './auth'

describe('validatePassword', () => {
  const original = process.env.AUTH_PASSWORD
  beforeEach(() => {
    process.env.AUTH_PASSWORD = 'correct-horse'
  })
  afterEach(() => {
    process.env.AUTH_PASSWORD = original
  })

  it('accepts the stored password and rejects others', () => {
    expect(validatePassword('correct-horse')).toBe(true)
    expect(validatePassword('correct-hors')).toBe(false)
    expect(validatePassword('wrong-horse!')).toBe(false)
  })

  it('returns false (never throws) for non-string input of matching length (F14 length oracle)', () => {
    // A 13-element array has .length === 'correct-horse'.length but no charCodeAt.
    const sameLength = Array.from({ length: 13 }, () => 'x')
    expect(() => validatePassword(sameLength as unknown as string)).not.toThrow()
    expect(validatePassword(sameLength as unknown as string)).toBe(false)
    expect(validatePassword({ length: 13 } as unknown as string)).toBe(false)
  })
})
