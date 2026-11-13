import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// storeRefreshToken (lib/spotify/auth) upserts token + issued_at into
// app_settings via supabase; mock supabase low-level and capture the upsert so
// both the OAuth-state success path (#206) and the issuance path (#219) can
// assert on the rows written.
const { upsertMock } = vi.hoisted(() => ({
  upsertMock: vi.fn(() => Promise.resolve({ error: null })),
}))
vi.mock('@/lib/supabase', () => ({
  supabase: { from: vi.fn(() => ({ upsert: upsertMock })) },
}))

// State validation reads the iron-session; the ?error= / missing-code paths
// return before getSession() is ever called, so those tests stay hermetic.
const mockGetSession = vi.fn()
vi.mock('@/lib/auth', () => ({
  getSession: (...a: unknown[]) => mockGetSession(...a),
}))

import { GET } from './route'

describe('spotify callback — reflected XSS (RLV-001)', () => {
  it('escapes the ?error= query param instead of reflecting raw HTML', async () => {
    const payload = '<img src=x onerror=alert(1)>'
    const req = new Request(
      `https://example.com/api/spotify/callback?error=${encodeURIComponent(payload)}`,
    )

    const res = await GET(req)
    const html = await res.text()

    // The raw tag must never appear verbatim in the response body.
    expect(html).not.toContain('<img src=x onerror=alert(1)>')
    // The dangerous characters must be entity-encoded.
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('escapes the error message body, not just the title', async () => {
    const payload = '</p><script>alert(1)</script>'
    const req = new Request(
      `https://example.com/api/spotify/callback?error=${encodeURIComponent(payload)}`,
    )

    const res = await GET(req)
    const html = await res.text()

    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })
})

describe('spotify callback — OAuth state validation (RLV-019)', () => {
  interface SessionStub {
    spotifyOauthState?: string
    save: ReturnType<typeof vi.fn>
  }

  function sessionWith(state?: string): SessionStub {
    const session: SessionStub = { save: vi.fn().mockResolvedValue(undefined) }
    if (state !== undefined) session.spotifyOauthState = state
    return session
  }

  const realFetch = global.fetch
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockGetSession.mockReset()
    upsertMock.mockClear()
    upsertMock.mockResolvedValue({ error: null })
    mockFetch = vi.fn()
    global.fetch = mockFetch as unknown as typeof fetch
    vi.stubEnv('SPOTIFY_CLIENT_ID', 'client-id')
    vi.stubEnv('SPOTIFY_CLIENT_SECRET', 'client-secret')
    vi.stubEnv('SPOTIFY_REDIRECT_URI', 'https://app.example.com/api/spotify/callback')
  })

  afterEach(() => {
    global.fetch = realFetch
    vi.unstubAllEnvs()
  })

  const url = (qs: string) => new Request(`https://example.com/api/spotify/callback?${qs}`)

  it('rejects a request with no state param and never exchanges the code', async () => {
    mockGetSession.mockResolvedValue(sessionWith('stored-state'))

    const res = await GET(url('code=abc'))
    const html = await res.text()

    expect(html).toContain('Invalid State')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('rejects a mismatched state and never exchanges the code', async () => {
    mockGetSession.mockResolvedValue(sessionWith('stored-state'))

    const res = await GET(url('code=abc&state=attacker-guess'))
    const html = await res.text()

    expect(html).toContain('Invalid State')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('rejects when the session holds no stored state (e.g. replay)', async () => {
    mockGetSession.mockResolvedValue(sessionWith())

    const res = await GET(url('code=abc&state=stored-state'))
    const html = await res.text()

    expect(html).toContain('Invalid State')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('clears the stored state even on a failed validation (one-time use)', async () => {
    const session = sessionWith('stored-state')
    mockGetSession.mockResolvedValue(session)

    await GET(url('code=abc&state=attacker-guess'))

    expect(session.spotifyOauthState).toBeUndefined()
    expect(session.save).toHaveBeenCalled()
  })

  it('proceeds with the token exchange when the state matches, clearing it first', async () => {
    const session = sessionWith('stored-state')
    mockGetSession.mockResolvedValue(session)
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ refresh_token: 'rt-123' }),
    })

    const res = await GET(url('code=abc&state=stored-state'))
    const html = await res.text()

    expect(html).toContain('Spotify Connected')
    expect(session.spotifyOauthState).toBeUndefined()
    expect(session.save).toHaveBeenCalled()
    expect(mockFetch).toHaveBeenCalledTimes(1)
    // storeRefreshToken upserts token + issued_at; assert the token row landed.
    const rows = upsertMock.mock.calls[0][0]
    const list = Array.isArray(rows) ? rows : [rows]
    expect(list.find((r: { key: string; value: string }) => r.key === 'spotify_refresh_token')?.value).toBe(
      'rt-123'
    )
  })

  it('keeps handling ?error= before any state logic (user-declined OAuth)', async () => {
    const res = await GET(url('error=access_denied'))
    const html = await res.text()

    expect(html).toContain('Authorization Failed')
    expect(mockGetSession).not.toHaveBeenCalled()
  })
})

describe('spotify callback — records token issuance (#219)', () => {
  const originalEnv = process.env

  beforeEach(() => {
    upsertMock.mockClear()
    upsertMock.mockResolvedValue({ error: null })
    // A valid OAuth state must be present for the callback to reach the token
    // exchange (#206); this test focuses on what gets persisted afterward.
    mockGetSession.mockReset()
    mockGetSession.mockResolvedValue({
      spotifyOauthState: 'valid-state',
      save: vi.fn().mockResolvedValue(undefined),
    })
    process.env = {
      ...originalEnv,
      SPOTIFY_CLIENT_ID: 'id',
      SPOTIFY_CLIENT_SECRET: 'secret',
      SPOTIFY_REDIRECT_URI: 'https://example.com/api/spotify/callback',
    }
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('stores the refresh token AND its issuance timestamp on success', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: 'a',
          refresh_token: 'fresh-refresh-token',
          expires_in: 3600,
        }),
    })

    const req = new Request(
      'https://example.com/api/spotify/callback?code=auth-code&state=valid-state'
    )
    const res = await GET(req)
    const html = await res.text()

    expect(html).toContain('Spotify Connected')
    expect(upsertMock).toHaveBeenCalledTimes(1)
    const rows = upsertMock.mock.calls[0][0]
    const list = Array.isArray(rows) ? rows : [rows]
    const byKey = Object.fromEntries(list.map((r: { key: string; value: string }) => [r.key, r.value]))

    expect(byKey['spotify_refresh_token']).toBe('fresh-refresh-token')
    expect(byKey['spotify_refresh_token_issued_at']).toBeDefined()
    expect(() => new Date(byKey['spotify_refresh_token_issued_at']).toISOString()).not.toThrow()
  })
})
