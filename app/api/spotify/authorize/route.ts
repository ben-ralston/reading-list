/**
 * Spotify OAuth Authorization Endpoint
 *
 * Redirects to Spotify's authorization page with the correct scopes.
 * After user authorizes, Spotify redirects to /api/spotify/callback.
 */

import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'

const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize'

// Scopes needed for progress sync:
// - user-library-read: Access saved episodes and followed shows
// - user-read-playback-position: Access resume points (progress)
// - user-library-modify: Save episodes auto-download missed (#310 show-gap scan)
const SCOPES = ['user-library-read', 'user-read-playback-position', 'user-library-modify']

export async function GET() {
  const clientId = process.env.SPOTIFY_CLIENT_ID
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI

  if (!clientId) {
    return NextResponse.json(
      { error: 'SPOTIFY_CLIENT_ID not configured' },
      { status: 500 }
    )
  }

  if (!redirectUri) {
    return NextResponse.json(
      { error: 'SPOTIFY_REDIRECT_URI not configured' },
      { status: 500 }
    )
  }

  // OAuth state (#206, RLV-019): a one-time nonce stored in the iron-session
  // and verified by the callback, so an attacker cannot CSRF our callback
  // into storing their refresh_token.
  const state = crypto.randomUUID()
  const session = await getSession()
  session.spotifyOauthState = state
  await session.save()

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES.join(' '),
    state,
  })

  const authUrl = `${SPOTIFY_AUTH_URL}?${params.toString()}`

  return NextResponse.redirect(authUrl)
}
