// Per-browser Spotify sync cooldown. Shared by the home auto-sync engine
// (app/home-client.tsx) and the manual sync control on the Status page
// (app/settings/status/spotify-sync-control.tsx) so a manual sync records the
// same timestamp and suppresses a redundant auto-sync immediately afterward.
export const LAST_SPOTIFY_SYNC_KEY = 'last-spotify-sync'
export const SPOTIFY_SYNC_COOLDOWN = 5 * 60 * 1000 // 5 minutes in ms
