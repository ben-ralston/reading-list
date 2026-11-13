/**
 * Spotify OAuth Callback Endpoint
 *
 * Receives the authorization code from Spotify, exchanges it for tokens,
 * and stores the refresh token in the database.
 */

import { timingSafeEqual } from 'crypto'
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { storeRefreshToken } from '@/lib/spotify/auth'

const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token'

interface TokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token: string
  scope: string
}

interface ErrorResponse {
  error: string
  error_description?: string
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const error = searchParams.get('error')

  // Handle authorization errors
  if (error) {
    return new NextResponse(
      renderHtml('Authorization Failed', `Spotify returned an error: ${escapeHtml(error)}`),
      { headers: { 'Content-Type': 'text/html' } }
    )
  }

  if (!code) {
    return new NextResponse(
      renderHtml('Missing Code', 'No authorization code received from Spotify.'),
      { headers: { 'Content-Type': 'text/html' } }
    )
  }

  // OAuth state validation (#206, RLV-019) — checked after error/code so a
  // user-declined flow still reads "Authorization Failed", but BEFORE the
  // token exchange so a CSRF'd callback can never store an attacker's
  // refresh_token. The stored nonce is single-use: cleared on every attempt.
  const stateParam = searchParams.get('state')
  const session = await getSession()
  const storedState = session.spotifyOauthState
  if (storedState !== undefined) {
    delete session.spotifyOauthState
    await session.save()
  }
  if (!storedState || !stateParam || !statesMatch(stateParam, storedState)) {
    return new NextResponse(
      renderHtml(
        'Invalid State',
        'OAuth state validation failed. Start the connection again from the app.'
      ),
      { status: 403, headers: { 'Content-Type': 'text/html' } }
    )
  }

  // Get credentials from env
  const clientId = process.env.SPOTIFY_CLIENT_ID
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI

  if (!clientId || !clientSecret || !redirectUri) {
    return new NextResponse(
      renderHtml('Configuration Error', 'Missing Spotify credentials in environment.'),
      { headers: { 'Content-Type': 'text/html' } }
    )
  }

  try {
    // Exchange code for tokens
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')

    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    })

    if (!response.ok) {
      const errorData = await response.json() as ErrorResponse
      return new NextResponse(
        renderHtml('Token Exchange Failed', escapeHtml(errorData.error_description || errorData.error)),
        { headers: { 'Content-Type': 'text/html' } }
      )
    }

    const tokenData = await response.json() as TokenResponse

    // Store refresh token + its issuance timestamp in the database
    const { error: dbError } = await storeRefreshToken(tokenData.refresh_token)

    if (dbError) {
      console.error('[Spotify Callback] Failed to store refresh token:', dbError)
      return new NextResponse(
        renderHtml('Database Error', 'Failed to store refresh token. Check server logs.'),
        { headers: { 'Content-Type': 'text/html' } }
      )
    }

    // Success!
    return new NextResponse(
      renderHtml(
        'Spotify Connected!',
        'Your Spotify account has been successfully connected. The sync will now run automatically every hour.',
        true
      ),
      { headers: { 'Content-Type': 'text/html' } }
    )
  } catch (err) {
    console.error('[Spotify Callback] Error:', err)
    return new NextResponse(
      renderHtml('Error', 'An unexpected error occurred. Check server logs.'),
      { headers: { 'Content-Type': 'text/html' } }
    )
  }
}

/**
 * Constant-time comparison of the query state against the stored nonce.
 * Length-guarded (lib/bearer-auth.ts pattern) because the attacker controls
 * the query value's length and timingSafeEqual throws on length mismatch.
 */
function statesMatch(candidate: string, stored: string): boolean {
  const a = Buffer.from(candidate)
  const b = Buffer.from(stored)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Escape user-controlled text before interpolating it into the HTML response.
 * RLV-001: Spotify sends `?error=` / `error_description` back to this endpoint,
 * both attacker-influenceable; without escaping they reflect verbatim into a
 * text/html body (there is no CSP), yielding on-origin reflected XSS.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Render a simple HTML page for the callback response
 */
function renderHtml(title: string, message: string, success = false): string {
  const color = success ? '#22c55e' : '#ef4444'
  const icon = success ? '✓' : '✗'

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: #0a0a0a;
      color: #fafafa;
    }
    .container {
      text-align: center;
      padding: 2rem;
      max-width: 400px;
    }
    .icon {
      font-size: 4rem;
      color: ${color};
      margin-bottom: 1rem;
    }
    h1 {
      margin: 0 0 1rem 0;
      font-size: 1.5rem;
    }
    p {
      color: #a1a1aa;
      line-height: 1.6;
    }
    .close-hint {
      margin-top: 2rem;
      font-size: 0.875rem;
      color: #71717a;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <p class="close-hint">You can close this window.</p>
  </div>
</body>
</html>
  `.trim()
}
