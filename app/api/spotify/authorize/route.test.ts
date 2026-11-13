import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockGetSession = vi.fn()
vi.mock('@/lib/auth', () => ({
  getSession: (...a: unknown[]) => mockGetSession(...a),
}))

import { GET } from './route'

interface SessionStub {
  spotifyOauthState?: string
  save: ReturnType<typeof vi.fn>
}

function sessionStub(): SessionStub {
  return { save: vi.fn().mockResolvedValue(undefined) }
}

beforeEach(() => {
  mockGetSession.mockReset()
  vi.stubEnv('SPOTIFY_CLIENT_ID', 'client-id')
  vi.stubEnv('SPOTIFY_REDIRECT_URI', 'https://app.example.com/api/spotify/callback')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('spotify authorize — OAuth state (RLV-019)', () => {
  it('includes a state param in the redirect and stores the same value in the session', async () => {
    const session = sessionStub()
    mockGetSession.mockResolvedValue(session)

    const res = await GET()

    expect([302, 307, 308]).toContain(res.status)
    const location = res.headers.get('location')
    expect(location).toBeTruthy()
    const url = new URL(location!)
    expect(url.origin + url.pathname).toBe('https://accounts.spotify.com/authorize')

    const state = url.searchParams.get('state')
    expect(state).toBeTruthy()
    expect(state!.length).toBeGreaterThanOrEqual(16)
    expect(session.spotifyOauthState).toBe(state)
    expect(session.save).toHaveBeenCalledTimes(1)
  })

  it('generates a fresh state per request', async () => {
    const first = sessionStub()
    const second = sessionStub()
    mockGetSession.mockResolvedValueOnce(first).mockResolvedValueOnce(second)

    await GET()
    await GET()

    expect(first.spotifyOauthState).toBeTruthy()
    expect(second.spotifyOauthState).toBeTruthy()
    expect(first.spotifyOauthState).not.toBe(second.spotifyOauthState)
  })

  it('still 500s without touching the session when credentials are missing', async () => {
    vi.stubEnv('SPOTIFY_CLIENT_ID', '')
    const res = await GET()
    expect(res.status).toBe(500)
    expect(mockGetSession).not.toHaveBeenCalled()
  })
})

describe('spotify authorize — scopes', () => {
  it('requests read, playback-position, and library-modify (#310 show-gap save)', async () => {
    mockGetSession.mockResolvedValue(sessionStub())

    const res = await GET()

    const scopes = new URL(res.headers.get('location')!).searchParams.get('scope')!.split(' ')
    expect(scopes.sort()).toEqual(
      ['user-library-modify', 'user-library-read', 'user-read-playback-position'].sort()
    )
  })
})
