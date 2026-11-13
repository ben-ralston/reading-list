'use server'

import { getSession, validatePassword } from '@/lib/auth'
import { reserveSigninAttempt, resetSigninThrottle } from '@/lib/signin-throttle'

export async function signIn(password: string): Promise<{ success: boolean; error?: string }> {
  // Runtime type check: server-action args come from attacker-supplied data (#281, F14).
  if (typeof password !== 'string' || !password) {
    return { success: false, error: 'Password is required' }
  }

  // Brute-force throttle (#206, RLV-018): gate BEFORE the password check so a
  // locked window never leaks whether a guess was correct. The attempt is
  // reserved (counted) atomically here, so concurrent guesses can't all slip
  // through the gate before any failure is recorded (#281, F1/F4).
  const gate = await reserveSigninAttempt()
  if (!gate.allowed) {
    return {
      success: false,
      error: `Too many failed attempts. Try again in ${gate.retryAfterSeconds}s.`,
    }
  }

  if (!validatePassword(password)) {
    // Already counted by reserveSigninAttempt.
    return { success: false, error: 'Invalid password' }
  }

  await resetSigninThrottle()

  const session = await getSession()
  session.isAuthenticated = true
  await session.save()

  return { success: true }
}

export async function signOut(): Promise<void> {
  const session = await getSession()
  session.destroy()
}
