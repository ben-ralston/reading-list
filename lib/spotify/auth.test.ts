import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Shared spies so tests can assert what gets written and control what is read.
const { upsertMock, maybeSingleMock } = vi.hoisted(() => ({
  upsertMock: vi.fn(() => Promise.resolve({ error: null })),
  maybeSingleMock: vi.fn(() => Promise.resolve({ data: null, error: null })),
}))

// Mock supabase before importing auth module
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: maybeSingleMock,
        })),
      })),
      upsert: upsertMock,
    })),
  },
}))

import { getAccessToken, SpotifyAuthError } from './auth'

describe('getAccessToken', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.resetModules()
    upsertMock.mockClear()
    upsertMock.mockResolvedValue({ error: null })
    maybeSingleMock.mockClear()
    maybeSingleMock.mockResolvedValue({ data: null, error: null })
    process.env = {
      ...originalEnv,
      SPOTIFY_CLIENT_ID: 'test-client-id',
      SPOTIFY_CLIENT_SECRET: 'test-client-secret',
      SPOTIFY_REFRESH_TOKEN: 'test-refresh-token',
    }
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('should return access token on successful refresh', async () => {
    const mockResponse = {
      access_token: 'new-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'user-library-read',
    }

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    })

    const token = await getAccessToken()

    expect(token).toBe('new-access-token')
    expect(fetch).toHaveBeenCalledWith(
      'https://accounts.spotify.com/api/token',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/x-www-form-urlencoded',
        }),
      })
    )
  })

  it('should include Basic auth header with encoded credentials', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'token' }),
    })

    await getAccessToken()

    const expectedAuth = Buffer.from('test-client-id:test-client-secret').toString('base64')
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Basic ${expectedAuth}`,
        }),
      })
    )
  })

  it('should throw SpotifyAuthError when credentials are missing', async () => {
    process.env.SPOTIFY_CLIENT_ID = ''

    await expect(getAccessToken()).rejects.toThrow(SpotifyAuthError)
    await expect(getAccessToken()).rejects.toThrow(/Missing Spotify credentials/)
  })

  it('should throw SpotifyAuthError when client secret is missing', async () => {
    process.env.SPOTIFY_CLIENT_SECRET = ''

    await expect(getAccessToken()).rejects.toThrow(SpotifyAuthError)
  })

  it('should throw SpotifyAuthError when refresh token is missing', async () => {
    process.env.SPOTIFY_REFRESH_TOKEN = ''

    await expect(getAccessToken()).rejects.toThrow(SpotifyAuthError)
  })

  it('should throw SpotifyAuthError on 401 response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () =>
        Promise.resolve({
          error: 'invalid_grant',
          error_description: 'Refresh token revoked',
        }),
    })

    await expect(getAccessToken()).rejects.toThrow(SpotifyAuthError)
    await expect(getAccessToken()).rejects.toThrow(/Refresh token revoked/)
  })

  it('should throw SpotifyAuthError on 400 response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () =>
        Promise.resolve({
          error: 'invalid_request',
          error_description: 'Missing parameter',
        }),
    })

    const error = await getAccessToken().catch((e) => e)

    expect(error).toBeInstanceOf(SpotifyAuthError)
    expect(error.statusCode).toBe(400)
    expect(error.errorCode).toBe('invalid_request')
  })

  it('should handle error response without description', async () => {
    // A 5xx is retried twice first (#342); fake timers skip the backoff.
    vi.useFakeTimers()
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'server_error' }),
    })

    const done = getAccessToken()
    const assertion = expect(done).rejects.toThrow('server_error')
    await vi.runAllTimersAsync()
    await assertion
    expect(fetch).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
  })

  it('retries a transient 5xx from the token endpoint (#342)', async () => {
    vi.useFakeTimers()
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: () => Promise.reject(new SyntaxError('Unexpected token <')),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ access_token: 'after-retry', token_type: 'Bearer', expires_in: 3600, scope: '' }),
      })

    const done = getAccessToken()
    await vi.runAllTimersAsync()
    await expect(done).resolves.toBe('after-retry')
    expect(fetch).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('records the issuance timestamp when Spotify rotates the refresh token', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: 'new-access-token',
          refresh_token: 'rotated-refresh-token',
        }),
    })

    await getAccessToken()

    expect(upsertMock).toHaveBeenCalledTimes(1)
    const rows = upsertMock.mock.calls[0][0]
    const list = Array.isArray(rows) ? rows : [rows]
    const byKey = Object.fromEntries(list.map((r) => [r.key, r.value]))

    expect(byKey['spotify_refresh_token']).toBe('rotated-refresh-token')
    // The issuance timestamp must be written alongside the rotated token so
    // token age is answerable without forensics (issue #219, task 1).
    expect(byKey['spotify_refresh_token_issued_at']).toBeDefined()
    expect(() => new Date(byKey['spotify_refresh_token_issued_at']).toISOString()).not.toThrow()
  })

  describe('refresh token source (ops issue #334)', () => {
    // Prod incident 2026-09-14: transient app_settings read failures made
    // getRefreshToken() fall back to the SPOTIFY_REFRESH_TOKEN env var, which
    // on Vercel is a months-old, pre-cutoff token. Spotify answered
    // "Refresh token expired" / "Refresh token revoked" and the alerting job raised
    // three alerts for a token that was in fact healthy. A DB read *failure*
    // must never present a stale token to Spotify; only a missing row may fall
    // back to the env var.

    it('uses the database token when the row exists, not the env var', async () => {
      maybeSingleMock.mockResolvedValue({ data: { value: 'db-refresh-token' }, error: null })
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ access_token: 'token' }),
      })

      await getAccessToken()

      const body = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as URLSearchParams
      expect(body.get('refresh_token')).toBe('db-refresh-token')
    })

    it('falls back to the env var only when the database has no row', async () => {
      maybeSingleMock.mockResolvedValue({ data: null, error: null })
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ access_token: 'token' }),
      })

      await getAccessToken()

      const body = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as URLSearchParams
      expect(body.get('refresh_token')).toBe('test-refresh-token')
    })

    it('does not fall back to the env var when the row exists but holds an empty value', async () => {
      // An existing-but-blank row is a cleared token, not an absent one; the
      // env var may be stale, so this must surface as "missing" rather than
      // silently switching tokens (Codex review finding on #334).
      maybeSingleMock.mockResolvedValue({ data: { value: '' }, error: null })
      global.fetch = vi.fn()

      const error = await getAccessToken().catch((e) => e)

      expect(error).toBeInstanceOf(SpotifyAuthError)
      expect(error.errorCode).toBe('missing_refresh_token')
      expect(fetch).not.toHaveBeenCalled()
    })

    it('fails instead of using the env var when the database read returns an error', async () => {
      maybeSingleMock.mockResolvedValue({
        data: null,
        error: { message: 'canceling statement due to statement timeout' },
      })
      global.fetch = vi.fn()

      const error = await getAccessToken().catch((e) => e)

      expect(error).toBeInstanceOf(SpotifyAuthError)
      expect(error.errorCode).toBe('refresh_token_unavailable')
      expect(error.message).toMatch(/statement timeout/)
      expect(fetch).not.toHaveBeenCalled()
    })

    it('fails instead of using the env var when the database read throws', async () => {
      maybeSingleMock.mockRejectedValue(new TypeError('fetch failed'))
      global.fetch = vi.fn()

      const error = await getAccessToken().catch((e) => e)

      expect(error).toBeInstanceOf(SpotifyAuthError)
      expect(error.errorCode).toBe('refresh_token_unavailable')
      expect(error.message).toMatch(/fetch failed/)
      expect(fetch).not.toHaveBeenCalled()
    })
  })

  it('does NOT rewrite the token/issuance when Spotify returns no new refresh token', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'new-access-token' }),
    })

    await getAccessToken()

    expect(upsertMock).not.toHaveBeenCalled()
  })
})
