/**
 * Spotify OAuth token management
 *
 * Uses a refresh token to obtain fresh access tokens for API calls.
 * Refresh tokens are stored in the database (preferred). The
 * SPOTIFY_REFRESH_TOKEN env var is a fallback for the *absence* of a database
 * row (local dev) only — never for a failed read. See getRefreshToken().
 */

import { supabase } from '@/lib/supabase'
import { serializeError } from '@/lib/sync/serialize-error'
import { fetchWithRetry } from '@/lib/fetch-with-retry'

const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token'

/** app_settings key holding the current Spotify refresh token. */
const REFRESH_TOKEN_KEY = 'spotify_refresh_token'
/**
 * app_settings key holding the ISO-8601 timestamp of when the current refresh
 * token was minted or last rotated. Spotify refresh tokens issued before
 * 2026-07-20 expire (issue #219); recording issuance makes token age
 * answerable without reverse-engineering `app_settings.updated_at`.
 */
const REFRESH_TOKEN_ISSUED_AT_KEY = 'spotify_refresh_token_issued_at'

export class SpotifyAuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly errorCode?: string
  ) {
    super(message)
    this.name = 'SpotifyAuthError'
  }
}

interface TokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token?: string // Spotify may return a new refresh token
  scope: string
}

interface ErrorResponse {
  error: string
  error_description?: string
}

/**
 * Get the refresh token from the database, falling back to the
 * SPOTIFY_REFRESH_TOKEN env var only when the database has no row at all
 * (an existing row with a blank value counts as "no token", not "no row").
 *
 * A database read *failure* (error or exception) throws instead of falling
 * back. The env var is typically a stale copy — on Vercel it is the token
 * minted at first deploy, long since superseded by the rotated/re-minted row
 * in `app_settings`. Presenting that stale token to Spotify during a transient
 * DB blip is what produced the "Refresh token expired" / "Refresh token
 * revoked" errors of 2026-09-14 (ops issue #334),
 * and under Spotify's reuse detection a stale token can revoke the live one.
 * Failing loudly with the real cause is strictly safer.
 *
 * @returns Refresh token or null if neither the database nor env has one
 * @throws SpotifyAuthError (`refresh_token_unavailable`) when the DB read fails
 */
async function getRefreshToken(): Promise<string | null> {
  let dbFailure: unknown = null
  let rowAbsent = false
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', REFRESH_TOKEN_KEY)
      .maybeSingle()

    if (error) {
      dbFailure = error
    } else if (data !== null) {
      // The row exists: its value is authoritative even when blank (a cleared
      // token). Never swap in the env var for an existing row.
      return data.value || null
    } else {
      rowAbsent = true
    }
  } catch (err) {
    dbFailure = err
  }

  if (dbFailure !== null) {
    const detail = serializeError(dbFailure).message
    console.error('[Spotify Auth] Failed to read refresh token from database:', dbFailure)
    throw new SpotifyAuthError(
      `Could not read the Spotify refresh token from the database (${detail}); ` +
        'not falling back to SPOTIFY_REFRESH_TOKEN because it may be stale.',
      undefined,
      'refresh_token_unavailable'
    )
  }

  // No row at all (e.g. local dev) — fall back to the environment variable.
  if (rowAbsent && process.env.SPOTIFY_REFRESH_TOKEN) {
    return process.env.SPOTIFY_REFRESH_TOKEN
  }

  return null
}

/**
 * Store a refresh token and record its issuance timestamp.
 *
 * Called on a fresh mint (OAuth callback) and whenever Spotify rotates the
 * token during a refresh. Both paths represent a newly-issued token, so the
 * issuance timestamp is (re)written alongside the token value.
 *
 * @param token The refresh token to persist
 * @returns `{ error }` — null on success, so callers can surface DB failures
 */
export async function storeRefreshToken(token: string): Promise<{ error: unknown }> {
  try {
    const iso = new Date().toISOString()
    const { error } = await supabase.from('app_settings').upsert([
      { key: REFRESH_TOKEN_KEY, value: token, updated_at: iso },
      { key: REFRESH_TOKEN_ISSUED_AT_KEY, value: iso, updated_at: iso },
    ])
    if (error) {
      console.error('[Spotify Auth] Failed to store refresh token:', error)
    }
    return { error: error ?? null }
  } catch (err) {
    console.error('[Spotify Auth] Network error storing refresh token:', err)
    return { error: err }
  }
}

/**
 * Get a fresh access token using the stored refresh token.
 * Access tokens are valid for ~1 hour.
 *
 * Reads the refresh token from the database first; falls back to the env var
 * only when no row exists (a failed read throws — see getRefreshToken).
 * If Spotify returns a new refresh token, it's stored in the database.
 *
 * @throws SpotifyAuthError if token refresh fails
 */
export async function getAccessToken(): Promise<string> {
  const clientId = process.env.SPOTIFY_CLIENT_ID
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET
  const refreshToken = await getRefreshToken()

  if (!clientId || !clientSecret) {
    throw new SpotifyAuthError(
      'Missing Spotify credentials. Ensure SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are set.',
      undefined,
      'missing_credentials'
    )
  }

  if (!refreshToken) {
    throw new SpotifyAuthError(
      'No Spotify refresh token found. Visit /api/spotify/authorize to connect your Spotify account.',
      undefined,
      'missing_refresh_token'
    )
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')

  // A gateway 5xx or a dropped connection is retried twice (#342). Safe to
  // repeat: in practice Spotify does not rotate the refresh token on use.
  const response = await fetchWithRetry(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  }, { retries: 2, baseDelay: 500 })

  if (!response.ok) {
    const errorData = await response.json() as ErrorResponse
    throw new SpotifyAuthError(
      errorData.error_description || errorData.error || 'Token refresh failed',
      response.status,
      errorData.error
    )
  }

  const data = await response.json() as TokenResponse

  // If Spotify returned a new refresh token, store it
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    console.log('[Spotify Auth] Storing rotated refresh token')
    await storeRefreshToken(data.refresh_token)
  }

  return data.access_token
}
