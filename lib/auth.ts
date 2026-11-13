import { getIronSession, SessionOptions, IronSession } from 'iron-session'
import { cookies } from 'next/headers'

/**
 * Session data stored in the encrypted cookie
 */
export interface SessionData {
  isAuthenticated: boolean
  /** One-time OAuth state nonce for the Spotify flow (#206, RLV-019). */
  spotifyOauthState?: string
}

/**
 * Default session state for unauthenticated users
 */
export const defaultSession: SessionData = {
  isAuthenticated: false,
}

/**
 * Get and validate the session secret
 */
function getSessionSecret(): string {
  const secret = process.env.AUTH_PASSWORD_SECRET
  if (!secret) {
    throw new Error('AUTH_PASSWORD_SECRET environment variable is required')
  }
  if (secret.length < 32) {
    throw new Error('AUTH_PASSWORD_SECRET must be at least 32 characters')
  }
  return secret
}

/**
 * Session configuration for iron-session
 */
export const sessionOptions: SessionOptions = {
  password: getSessionSecret(),
  cookieName: '_auth',
  cookieOptions: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: 60 * 60 * 24 * 30, // 30 days
    path: '/',
  },
}

/**
 * Get the session from cookies (for use in Server Components and Server Actions)
 */
export async function getSession(): Promise<IronSession<SessionData>> {
  const cookieStore = await cookies()
  const session = await getIronSession<SessionData>(cookieStore, sessionOptions)

  // Set defaults if session is empty
  if (!session.isAuthenticated) {
    session.isAuthenticated = false
  }

  return session
}

/**
 * Constant-time string comparison (edge-compatible, no Node.js crypto)
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do the work to avoid timing leaks on length
    let dummy = 0
    for (let i = 0; i < b.length; i++) {
      dummy |= b.charCodeAt(i)
    }
    return false && dummy === 0 // Always false, but uses dummy
  }

  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}

/**
 * Validate the provided password against the stored password using constant-time comparison
 */
export function validatePassword(password: string): boolean {
  // Server-action args are decoded from attacker-supplied data, so the type is
  // not guaranteed at runtime. A non-string of matching length would throw in
  // constantTimeEqual and leak the stored password's length (#281, F14).
  if (typeof password !== 'string') return false
  const storedPassword = process.env.AUTH_PASSWORD
  if (!storedPassword) {
    console.error('AUTH_PASSWORD environment variable is not set')
    return false
  }

  return constantTimeEqual(password, storedPassword)
}
