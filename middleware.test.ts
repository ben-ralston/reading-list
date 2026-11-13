import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { middleware } from './middleware'

// Mock iron-session so we control isAuthenticated without real cookies/crypto.
const mockGetIronSession = vi.fn()
vi.mock('iron-session', () => ({
  getIronSession: (...args: unknown[]) => mockGetIronSession(...args),
}))

// @/lib/auth exports sessionOptions (a value) + SessionData (a type, erased).
vi.mock('@/lib/auth', () => ({
  sessionOptions: { password: 'x'.repeat(32), cookieName: 'test-session' },
}))

function req(path: string): NextRequest {
  return new NextRequest(new URL(`http://localhost${path}`))
}

describe('middleware auth (RLV-015)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('unauthenticated', () => {
    beforeEach(() => {
      mockGetIronSession.mockResolvedValue({ isAuthenticated: false })
    })

    it('returns 401 JSON for /api/* instead of an HTML redirect', async () => {
      const res = await middleware(req('/api/queue'))

      expect(res.status).toBe(401)
      expect(res.headers.get('content-type')).toContain('application/json')
      // Must NOT be a redirect — fetchWithRetry would otherwise follow the 307
      // to the /sign-in HTML page and read the 200 HTML as a successful write.
      expect(res.headers.get('location')).toBeNull()
      const body = await res.json()
      expect(body.error).toBe('Unauthorized')
    })

    it('returns 401 JSON for a nested /api/* path', async () => {
      const res = await middleware(req('/api/settings/feed-defaults'))
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('Unauthorized')
    })

    it('still redirects page routes to /sign-in (HTML clients)', async () => {
      const res = await middleware(req('/archive'))

      expect(res.status).toBe(307)
      expect(res.headers.get('location')).toContain('/sign-in')
    })
  })

  describe('authenticated', () => {
    beforeEach(() => {
      mockGetIronSession.mockResolvedValue({ isAuthenticated: true })
    })

    it('passes /api/* through untouched', async () => {
      const res = await middleware(req('/api/queue'))
      expect(res.status).toBe(200)
      expect(res.headers.get('location')).toBeNull()
    })

    it('passes page routes through untouched', async () => {
      const res = await middleware(req('/archive'))
      expect(res.status).toBe(200)
    })
  })
})
