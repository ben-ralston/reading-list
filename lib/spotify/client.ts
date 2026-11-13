/**
 * Spotify Web API client
 *
 * Fetches saved episodes with resume points for progress tracking.
 */

import { fetchWithRetry } from '@/lib/fetch-with-retry'

const SPOTIFY_API_BASE = 'https://api.spotify.com/v1'

/**
 * Every Spotify Web API request goes through this (#342): Spotify answers the
 * odd 502/503/504, and the odd connection drops, so a 5xx or a network
 * TypeError is retried twice with jittered backoff (~0.5 s, then ~1 s) before
 * the caller sees it. 4xx (including 429, handled per call below) are not
 * retried here.
 */
function spotifyFetch(url: string, init: RequestInit): Promise<Response> {
  return fetchWithRetry(url, init, { retries: 2, baseDelay: 500 })
}

export class SpotifyApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly retryAfter?: number
  ) {
    super(message)
    this.name = 'SpotifyApiError'
  }
}

/**
 * True for a Spotify 5xx (#342). The client has already retried it, so what
 * reaches a caller is an upstream outage that fixes itself: callers log it at
 * warn, not error, so the alerting job does not file an issue for every one.
 */
export function isSpotifyServerError(error: unknown): error is SpotifyApiError {
  return error instanceof SpotifyApiError && error.statusCode >= 500
}

export interface SpotifyShow {
  id: string
  name: string
}

export interface ResumePoint {
  fully_played: boolean
  resume_position_ms: number
}

export interface SpotifyImage {
  url: string
  height?: number | null
  width?: number | null
}

export interface SpotifyEpisode {
  id: string
  name: string
  duration_ms: number
  release_date: string // Format: YYYY-MM-DD or YYYY-MM or YYYY
  show: SpotifyShow
  external_urls: {
    spotify: string
  }
  // Episode cover art, largest-first (#167). Returned by /me/episodes by default.
  images?: SpotifyImage[]
  resume_point?: ResumePoint // resume_point is inside the episode object
}

export interface SavedEpisode {
  added_at: string
  episode: SpotifyEpisode
}

interface SavedEpisodesResponse {
  items: SavedEpisode[]
  next: string | null
  total: number
  limit: number
  offset: number
}

/**
 * Fetch all saved episodes with resume points.
 * Handles pagination automatically.
 *
 * @param accessToken - Valid Spotify access token
 * @returns Array of saved episodes with progress data
 * @throws SpotifyApiError if API call fails
 */
export async function fetchSavedEpisodes(accessToken: string): Promise<SavedEpisode[]> {
  const allEpisodes: SavedEpisode[] = []
  // market=from_token uses user's account market; required for resume_point data
  let url: string | null = `${SPOTIFY_API_BASE}/me/episodes?limit=50&market=from_token`

  while (url) {
    const response = await spotifyFetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    })

    if (!response.ok) {
      const retryAfter = response.headers.get('Retry-After')
      throw new SpotifyApiError(
        `Spotify API error: ${response.statusText}`,
        response.status,
        retryAfter ? parseInt(retryAfter, 10) : undefined
      )
    }

    const data = await response.json() as SavedEpisodesResponse
    allEpisodes.push(...data.items)
    url = data.next
  }

  return allEpisodes
}

/**
 * Fetch one episode's duration by id (#194 duration backfill). Single-get.
 * (The batch /episodes?ids= endpoint still answers this app's token — #329
 * verified it live — see fetchEpisodes.) Returns null on 404 (removed/region-blocked episodes are
 * expected in an old library, not an error).
 *
 * @throws SpotifyApiError on any non-404 failure (429 keeps Retry-After)
 */
export async function fetchEpisode(
  accessToken: string,
  episodeId: string
): Promise<{ duration_ms: number } | null> {
  const response = await spotifyFetch(`${SPOTIFY_API_BASE}/episodes/${episodeId}?market=from_token`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (response.status === 404) return null

  if (!response.ok) {
    const retryAfter = response.headers.get('Retry-After')
    throw new SpotifyApiError(
      `Spotify API error: ${response.statusText}`,
      response.status,
      retryAfter ? parseInt(retryAfter, 10) : undefined
    )
  }

  const data = (await response.json()) as { duration_ms: number }
  return { duration_ms: data.duration_ms }
}

export interface ShowEpisode {
  id: string
  name: string
  duration_ms: number
  release_date: string
  external_urls: {
    spotify: string
  }
  // Present on show-episode pages too; the #310 show-gap scan carries them
  // into the synthesized SavedEpisode so recovered episodes match saved ones.
  images?: SpotifyImage[]
  resume_point?: ResumePoint
}

interface ShowEpisodesResponse {
  // Spotify returns null placeholders for unavailable episodes
  items: (ShowEpisode | null)[]
  next: string | null
  total: number
}

/**
 * Fetch a public show's episodes page by page, newest-first.
 * Yields each 50-episode page so the caller can stop paging early
 * (the public Askwho Casts sync stops once a page is fully known).
 *
 * @throws SpotifyApiError if any page request fails
 */
// A 429 mid-pagination would otherwise abort the whole public sync phase;
// honor a short Retry-After once per page instead of failing the run.
const MAX_RETRY_AFTER_SECONDS = 30

export async function* fetchShowEpisodePages(
  showId: string,
  accessToken: string,
  { limit = 50 }: { limit?: number } = {}
): AsyncGenerator<ShowEpisode[]> {
  let url: string | null = `${SPOTIFY_API_BASE}/shows/${showId}/episodes?limit=${limit}&market=from_token`
  let retriedThisPage = false

  while (url) {
    const response = await spotifyFetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    })

    if (!response.ok) {
      const retryAfter = response.headers.get('Retry-After')
      const retrySeconds = retryAfter ? parseInt(retryAfter, 10) : NaN
      if (
        response.status === 429 &&
        !retriedThisPage &&
        Number.isFinite(retrySeconds) &&
        retrySeconds >= 0 &&
        retrySeconds <= MAX_RETRY_AFTER_SECONDS
      ) {
        retriedThisPage = true
        await new Promise((resolve) => setTimeout(resolve, retrySeconds * 1000))
        continue
      }
      throw new SpotifyApiError(
        `Spotify API error: ${response.statusText}`,
        response.status,
        Number.isFinite(retrySeconds) ? retrySeconds : undefined
      )
    }

    retriedThisPage = false
    const data = (await response.json()) as ShowEpisodesResponse
    yield data.items.filter((e): e is ShowEpisode => e != null)
    url = data.next
  }
}

interface EpisodeWithShow {
  id: string
  show: SpotifyShow | null
}

interface EpisodesByIdResponse {
  // Spotify returns null placeholders for unavailable/invalid ids.
  episodes: (EpisodeWithShow | null)[]
}

const EPISODES_BATCH_SIZE = 50

/**
 * Resolve a set of Spotify episode ids to their show names (#245 backfill).
 *
 * Batches the /v1/episodes?ids= endpoint (max 50 ids per request) and honors a
 * short Retry-After on a 429 once per batch, mirroring fetchShowEpisodePages.
 * Episodes that are null placeholders or carry no show are simply omitted from
 * the returned map, so the caller writes a label only where one truly exists.
 *
 * @param episodeIds - bare Spotify episode ids (no `spotify:episode:` prefix)
 * @param accessToken - Valid Spotify access token
 * @returns Map of episode id → show name
 * @throws SpotifyApiError if a batch request fails unrecoverably
 */
export async function fetchEpisodesByIds(
  episodeIds: string[],
  accessToken: string
): Promise<Map<string, string>> {
  const showById = new Map<string, string>()

  for (let i = 0; i < episodeIds.length; i += EPISODES_BATCH_SIZE) {
    const batch = episodeIds.slice(i, i + EPISODES_BATCH_SIZE)
    let retriedThisBatch = false

    for (;;) {
      const url = `${SPOTIFY_API_BASE}/episodes?ids=${batch.join(',')}&market=from_token`
      const response = await spotifyFetch(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      })

      if (!response.ok) {
        const retryAfter = response.headers.get('Retry-After')
        const retrySeconds = retryAfter ? parseInt(retryAfter, 10) : NaN
        if (
          response.status === 429 &&
          !retriedThisBatch &&
          Number.isFinite(retrySeconds) &&
          retrySeconds >= 0 &&
          retrySeconds <= MAX_RETRY_AFTER_SECONDS
        ) {
          retriedThisBatch = true
          await new Promise((resolve) => setTimeout(resolve, retrySeconds * 1000))
          continue
        }
        throw new SpotifyApiError(
          `Spotify API error: ${response.statusText}`,
          response.status,
          Number.isFinite(retrySeconds) ? retrySeconds : undefined
        )
      }

      const data = (await response.json()) as EpisodesByIdResponse
      for (const episode of data.episodes) {
        if (episode?.show?.name) showById.set(episode.id, episode.show.name)
      }
      break
    }
  }

  return showById
}

/**
 * Fetch full episodes, resume points included, by id (#329). Batches the
 * /v1/episodes?ids= endpoint (max 50 ids per request); null placeholders for
 * unavailable ids are dropped.
 *
 * @throws SpotifyApiError on failure (429 honors a short Retry-After once per batch)
 */
export async function fetchEpisodes(
  episodeIds: string[],
  accessToken: string
): Promise<SpotifyEpisode[]> {
  const episodes: SpotifyEpisode[] = []
  for (let i = 0; i < episodeIds.length; i += EPISODES_BATCH_SIZE) {
    const batch = episodeIds.slice(i, i + EPISODES_BATCH_SIZE)
    const response = await fetchWithShortRetry(
      `${SPOTIFY_API_BASE}/episodes?ids=${batch.join(',')}&market=from_token`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    )
    const data = (await response.json()) as { episodes: (SpotifyEpisode | null)[] }
    episodes.push(...data.episodes.filter((e): e is SpotifyEpisode => e != null))
  }
  return episodes
}

/**
 * spotifyFetch() that honors a short Retry-After once on 429 (the same policy as
 * fetchShowEpisodePages / fetchEpisodesByIds) and throws SpotifyApiError on
 * any other failure. Returns only ok responses.
 */
async function fetchWithShortRetry(url: string, init: RequestInit): Promise<Response> {
  let retried = false
  for (;;) {
    const response = await spotifyFetch(url, init)
    if (response.ok) return response

    const retryAfter = response.headers.get('Retry-After')
    const retrySeconds = retryAfter ? parseInt(retryAfter, 10) : NaN
    if (
      response.status === 429 &&
      !retried &&
      Number.isFinite(retrySeconds) &&
      retrySeconds >= 0 &&
      retrySeconds <= MAX_RETRY_AFTER_SECONDS
    ) {
      retried = true
      await new Promise((resolve) => setTimeout(resolve, retrySeconds * 1000))
      continue
    }
    throw new SpotifyApiError(
      `Spotify API error: ${response.statusText}`,
      response.status,
      Number.isFinite(retrySeconds) ? retrySeconds : undefined
    )
  }
}

export interface SavedShow {
  added_at: string
  show: SpotifyShow
}

interface SavedShowsResponse {
  items: SavedShow[]
  next: string | null
}

/**
 * Fetch every show the user follows (#310). "Following" a podcast in the
 * Spotify app is saving the show; added_at is when it was followed.
 *
 * @throws SpotifyApiError if any page request fails
 */
export async function fetchSavedShows(accessToken: string): Promise<SavedShow[]> {
  const shows: SavedShow[] = []
  let url: string | null = `${SPOTIFY_API_BASE}/me/shows?limit=50`

  while (url) {
    const response = await fetchWithShortRetry(url, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    })
    const data = (await response.json()) as SavedShowsResponse
    shows.push(...data.items)
    url = data.next
  }

  return shows
}

/** PUT /me/library accepts at most 40 URIs per request. */
export const LIBRARY_SAVE_BATCH_SIZE = 40

/**
 * Save Spotify URIs to the user's library (#310). PUT /me/library replaced
 * the per-type PUT /me/episodes in the Feb 2026 Web API restructure. Needs the
 * user-library-modify scope — a token minted without it gets 403.
 *
 * @throws SpotifyApiError on failure (429 honors a short Retry-After once per batch)
 */
export async function saveToLibrary(accessToken: string, uris: string[]): Promise<void> {
  for (let i = 0; i < uris.length; i += LIBRARY_SAVE_BATCH_SIZE) {
    const batch = uris.slice(i, i + LIBRARY_SAVE_BATCH_SIZE)
    // Literal commas between individually-encoded URIs, as in Spotify's docs.
    const url = `${SPOTIFY_API_BASE}/me/library?uris=${batch.map(encodeURIComponent).join(',')}`
    await fetchWithShortRetry(url, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${accessToken}` },
    })
  }
}
