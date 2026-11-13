# Spotify re-auth runbook

The podcast sync (`/api/cron/spotify-sync`) depends on a stored Spotify **refresh
token**. Spotify announced (Jun 21, 2026) that refresh tokens issued **before
July 20, 2026 expire** starting on that date. When a token expires the token
refresh in `lib/spotify/auth.ts` starts returning `invalid_grant` and the cron
fails with a `SpotifyAuthError`.

This runbook re-mints a fresh refresh token. **It requires an interactive
Spotify login — steps marked 🧑 need the owner in the loop and cannot be automated.**

## When to run

- Spotify emails an "action required" token-expiry notice, **or**
- the `spotify_refresh_token_issued_at` row in `app_settings` shows the current
  token was issued before a Spotify cutoff, **or**
- `sync_logs` shows `spotify` rows failing with `Auth error: ... invalid_grant`.

### Check the current token's issuance date

```bash
source .env.local
PROJECT_REF=$(echo "$POSTGRES_URL" | sed -n 's/.*postgres\.\([^:]*\):.*/\1/p')
curl -s "https://${PROJECT_REF}.supabase.co/rest/v1/app_settings?key=in.(spotify_refresh_token,spotify_refresh_token_issued_at)&select=key,value,updated_at" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" | jq .
```

`spotify_refresh_token_issued_at` is written whenever the token is minted (OAuth
callback) or rotated (`lib/spotify/auth.ts`). For tokens minted before that field
existed, fall back to `spotify_refresh_token`'s `updated_at`.

## Re-auth steps

Prereqs (already set in Vercel prod): `SPOTIFY_CLIENT_ID`,
`SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI`. The redirect URI must exactly
match a Redirect URI registered in the
[Spotify developer dashboard](https://developer.spotify.com/dashboard) for this
app (prod: the deployed `/api/spotify/callback` URL).

1. 🧑 In a browser **logged in as the Spotify account that owns the library**,
   visit the production authorize endpoint:
   `https://<prod-domain>/api/spotify/authorize`
2. 🧑 Approve the scopes (`user-library-read`, `user-read-playback-position`,
   `user-library-modify`). `user-library-modify` was added for the #310
   show-gap scan, which saves episodes Spotify's auto-download missed; a token
   minted before #310 lacks it, so the scan runs detect-only (the cron's
   `sync_logs.metadata.show_gap` shows `save_status: 403`) until this re-auth.
   Spotify redirects to `/api/spotify/callback`, which exchanges the code and
   writes the new `spotify_refresh_token` **and** `spotify_refresh_token_issued_at`
   to `app_settings` (prod DB). You should see the "Spotify Connected!" page.
3. Verify the new issuance timestamp with the check query above — it should be
   `now`.
4. **Verify the cron end-to-end** against the new token:
   ```bash
   curl -s -X GET "https://<prod-domain>/api/cron/spotify-sync" \
     -H "Authorization: Bearer ${SYNC_API_SECRET}" | jq .
   ```
   Expect `{"success": true, ...}` and a fresh `success` row in `sync_logs`.
   With the modify scope, a run that finds missing episodes reports
   `"showGap": {"missing": N, "saved": N}` (no `save_error` in
   `sync_logs.metadata.show_gap`).

## Transient "expired" / "revoked" errors while the token is healthy

If `sync_logs` shows an isolated `Refresh token expired` / `Refresh token
revoked` row sandwiched between successes (as on 2026-09-14,
ops issue #334), the stored token is fine. Before that fix,
a transient `app_settings` read failure made `getRefreshToken()` fall back to
the `SPOTIFY_REFRESH_TOKEN` env var, which on Vercel is the token minted at
first deploy — long since superseded by the row in `app_settings` — and Spotify
rejected it. `lib/spotify/auth.ts` now throws
`SpotifyAuthError('refresh_token_unavailable')` on a DB read failure instead
of using the env var, so the cron fails with the real cause and simply retries
next tick. The env fallback still applies when the database has **no row**.

Because the Vercel copy of `SPOTIFY_REFRESH_TOKEN` is stale, it should be
deleted from the Production (and Preview) environments so nothing can ever
reach for it: `vercel env rm SPOTIFY_REFRESH_TOKEN production`.

## Local dev

Local dev reads the refresh token from the `app_settings` row in whichever
Supabase it points at, falling back to the `SPOTIFY_REFRESH_TOKEN` env var
(`.env.local`) only when that row does not exist. If you keep a local token for offline testing, refresh it the
same way (run the flow against `http://localhost:3000/api/spotify/authorize`
with a matching localhost redirect URI registered in the Spotify dashboard) or
copy the freshly-minted prod token into `.env.local`.

> Note: going forward Spotify rotates refresh tokens on use. `getAccessToken()`
> already persists a rotated token (and its new issuance date), so a healthy
> hourly cron keeps the token perpetually fresh — this manual re-auth is only
> needed to recover from an expired/revoked token.
