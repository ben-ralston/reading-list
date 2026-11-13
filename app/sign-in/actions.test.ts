import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetSession = vi.fn()
const mockValidatePassword = vi.fn()
vi.mock('@/lib/auth', () => ({
  getSession: (...a: unknown[]) => mockGetSession(...a),
  validatePassword: (...a: unknown[]) => mockValidatePassword(...a),
}))

const mockReserveSigninAttempt = vi.fn()
const mockResetSigninThrottle = vi.fn()
vi.mock('@/lib/signin-throttle', () => ({
  reserveSigninAttempt: (...a: unknown[]) => mockReserveSigninAttempt(...a),
  resetSigninThrottle: (...a: unknown[]) => mockResetSigninThrottle(...a),
}))

import { signIn } from './actions'

function sessionStub() {
  return { isAuthenticated: false, save: vi.fn().mockResolvedValue(undefined) }
}

beforeEach(() => {
  mockGetSession.mockReset()
  mockValidatePassword.mockReset()
  mockReserveSigninAttempt.mockReset()
  mockResetSigninThrottle.mockReset()
  mockReserveSigninAttempt.mockResolvedValue({ allowed: true })
  mockResetSigninThrottle.mockResolvedValue(undefined)
})

describe('signIn', () => {
  it('rejects an empty password without touching the throttle', async () => {
    const result = await signIn('')
    expect(result).toEqual({ success: false, error: 'Password is required' })
    expect(mockReserveSigninAttempt).not.toHaveBeenCalled()
  })

  it('rejects a non-string password without touching the throttle or the comparison (F14)', async () => {
    for (const bad of [123, ['x'], { length: 8 }, null]) {
      const result = await signIn(bad as unknown as string)
      expect(result).toEqual({ success: false, error: 'Password is required' })
    }
    expect(mockReserveSigninAttempt).not.toHaveBeenCalled()
    expect(mockValidatePassword).not.toHaveBeenCalled()
  })

  it('rejects with a retry message when throttled, without checking the password', async () => {
    mockReserveSigninAttempt.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 })

    const result = await signIn('whatever')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/too many failed attempts/i)
    expect(result.error).toContain('42')
    expect(mockValidatePassword).not.toHaveBeenCalled()
  })

  it('reserves the attempt before comparing, and leaves it counted on a wrong password', async () => {
    mockValidatePassword.mockReturnValue(false)

    const result = await signIn('wrong')

    expect(result).toEqual({ success: false, error: 'Invalid password' })
    expect(mockReserveSigninAttempt).toHaveBeenCalledTimes(1)
    expect(mockReserveSigninAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      mockValidatePassword.mock.invocationCallOrder[0]
    )
    expect(mockResetSigninThrottle).not.toHaveBeenCalled()
    expect(mockGetSession).not.toHaveBeenCalled()
  })

  it('resets the throttle and saves the session on a correct password', async () => {
    mockValidatePassword.mockReturnValue(true)
    const session = sessionStub()
    mockGetSession.mockResolvedValue(session)

    const result = await signIn('correct')

    expect(result).toEqual({ success: true })
    expect(mockResetSigninThrottle).toHaveBeenCalledTimes(1)
    expect(session.isAuthenticated).toBe(true)
    expect(session.save).toHaveBeenCalledTimes(1)
  })
})
