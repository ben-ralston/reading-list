/**
 * Tests for Spotify Sync Cron Handler
 *
 * Tests the status preservation logic that prevents downgrading
 * from Completed to In Progress during sync.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from './route'
import { getAccessToken, SpotifyAuthError } from '@/lib/spotify/auth'
import { fetchSavedEpisodes, SpotifyApiError } from '@/lib/spotify/client'
import { recoverShowGaps } from '@/lib/spotify/show-gaps'
import { fetchUnsavedQueueEpisodes } from '@/lib/spotify/unsaved-episodes'

const mockLogError = vi.fn().mockResolvedValue(undefined)
const mockLogWarn = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/logger', () => ({
  logError: (...a: unknown[]) => mockLogError(...a),
  logWarn: (...a: unknown[]) => mockLogWarn(...a),
}))

// Mock the external dependencies. mockFrom (not a flat mockReturnThis()
// object) matches the pattern used by the rss-sync/askwhocasts-sync sibling
// route tests: a `const mockXxx = ...` referenced from inside a vi.mock
// factory must be a "mock"-prefixed vi.fn()-style binding for Vitest's
// hoisting to make it available in time — a plain object literal referenced
// by name hits a temporal-dead-zone ReferenceError the moment anything
// actually imports '@/lib/supabase', which never happened before this file's
// tests all called GET() (they were doc-only placeholders until now).
const mockFrom = vi.fn()
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: vi.fn(),
  },
}))

vi.mock('@/lib/spotify/auth', () => ({
  getAccessToken: vi.fn().mockResolvedValue('mock-access-token'),
  SpotifyAuthError: class extends Error {
    constructor(
      message: string,
      public readonly statusCode?: number,
      public readonly errorCode?: string,
    ) {
      super(message)
      this.name = 'SpotifyAuthError'
    }
  },
}))

// The real SpotifyApiError / isSpotifyServerError, so the #342 log-level
// split is tested against the same class the client throws.
vi.mock('@/lib/spotify/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/spotify/client')>()),
  fetchSavedEpisodes: vi.fn().mockResolvedValue([]),
}))
// The #329 unsaved-queue-episode lookup has its own tests
// (unsaved-episodes.test.ts) — here it finds nothing.
vi.mock('@/lib/spotify/unsaved-episodes', () => ({
  fetchUnsavedQueueEpisodes: vi.fn().mockResolvedValue([]),
}))
// Bearer runs also run the #310 show-gap scan; it has its own tests
// (show-gap.test.ts) — here it finds nothing so these scenarios are unchanged.
vi.mock('@/lib/spotify/show-gaps', () => ({
  recoverShowGaps: vi.fn().mockResolvedValue({
    recovered: [],
    report: { shows_scanned: 0, missing: 0, saved: 0, by_show: {}, episodes: [] },
  }),
}))

// route.ts imports generateSummary for Phase C (new-item background summary
// generation); its real module constructs an Anthropic client at import
// time, which throws under vitest's environment. Not exercised by these
// zero-episode scenarios, but the module-level import still needs a mock.
vi.mock('@/lib/summary', () => ({
  generateSummary: vi.fn().mockResolvedValue({ summary: 'test', generatedAt: '' }),
}))

/**
 * Creates a deeply chainable mock object where every method returns itself,
 * and terminal methods (single, maybeSingle) resolve with the provided value.
 * Mirrors the same helper in app/api/cron/rss-sync/route.test.ts.
 */
function createDeepChain(terminalValue: { data?: unknown; error?: unknown } = { data: null, error: null }) {
  const chain: Record<string, unknown> = {}
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_target, prop) {
      if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined
      if (prop === 'single' || prop === 'maybeSingle') {
        return vi.fn().mockResolvedValue(terminalValue)
      }
      return vi.fn().mockReturnValue(new Proxy({}, handler))
    },
  }
  return new Proxy(chain, handler)
}

/**
 * Sets up the standard Supabase mock for sync_logs operations: insert →
 * select → single() creates the row; update → eq() finalizes it. Any other
 * table falls through to the generic deep chain (unused by the zero-episode
 * scenarios these tests drive, but kept as a safe default).
 */
let syncLogUpdates: Record<string, unknown>[] = []
function setupSyncLogsMock(options: { updateError?: { message: string } } = {}) {
  syncLogUpdates = []
  mockFrom.mockImplementation((table: string) => {
    if (table === 'sync_logs') {
      return {
        insert: () => ({
          select: () => ({
            single: () => Promise.resolve({ data: { id: 1 }, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          syncLogUpdates.push(payload)
          return { eq: () => Promise.resolve({ error: options.updateError ?? null }) }
        },
      }
    }
    return createDeepChain({ data: null, error: null })
  })
}

describe('Spotify Sync Status Preservation', () => {
  /**
   * Test the shouldUpdateStatus logic directly.
   * This logic is internal to the route but we test the expected behavior.
   */
  // shouldUpdateStatus / per-item update assembly moved to
  // lib/spotify/sync-updates.ts (#192) and is tested directly in
  // lib/spotify/sync-updates.test.ts — including the cross-source progress
  // high-water mark that keeps this cron from lowering Substack-read progress.

  describe('GET /api/cron/spotify-sync integration', () => {
    // Reset all mocks before each test
    beforeEach(() => {
      vi.resetAllMocks()
    })

    it('should preserve Completed status when Spotify reports In Progress', async () => {
      // This is a documentation test describing the expected behavior
      // Full integration testing would require more complex mocking
      //
      // Scenario:
      // 1. Episode is marked Completed in database (user finished it)
      // 2. User moves playback position in Spotify
      // 3. Spotify API reports episode as In Progress (fully_played=false)
      // 4. Sync should NOT update status to In Progress
      // 5. Status should remain Completed in database
      //
      // This behavior is handled by:
      // - Phase A4 batch-fetches current statuses into statusMap
      // - shouldUpdateStatus() returns null when current=Completed, new=In Progress
      // - The batch RPC omits status from the update when shouldUpdateStatus returns null

      expect(true).toBe(true) // Placeholder for integration test
    })

    it('should add new episodes with empty status when no progress', async () => {
      // This is a documentation test describing the expected behavior
      //
      // Scenario:
      // 1. User saves a new episode in Spotify
      // 2. Episode has no playback progress (resume_position_ms=0, fully_played=false)
      // 3. Sync should add the episode to the database
      // 4. Episode should have empty status ('') like email imports
      //
      // This behavior is handled by:
      // - transformToSyncItems() includes zero-progress episodes
      // - determineStatus(0, false) returns ''
      // - normalizeStatus('') returns null
      // - Phase C creates new item with no status set

      expect(true).toBe(true) // Placeholder for integration test
    })

    it('should use batch operations for matched items', async () => {
      // This is a documentation test describing the batch behavior
      //
      // The sync route uses a three-phase approach:
      // - Phase A: Batch pre-fetch (external IDs, author candidates, statuses, sources)
      // - Phase B: In-memory matching + single batch_update_content_items RPC
      // - Phase C: Sequential creation for new items only
      //
      // This reduces ~200-300 sequential DB queries to ~5 bulk queries + 1 batch RPC

      expect(true).toBe(true) // Placeholder for integration test
    })

    describe('log service (#269)', () => {
      const MOCK_SECRET = 'test-secret-123'

      function createRequest(bearerToken?: string): Request {
        const headers: Record<string, string> = {}
        if (bearerToken) headers['authorization'] = `Bearer ${bearerToken}`
        return new Request('http://localhost/api/cron/spotify-sync', { method: 'GET', headers })
      }

      beforeEach(() => {
        process.env.SYNC_API_SECRET = MOCK_SECRET
        mockLogError.mockClear()
        mockLogWarn.mockClear()
        // vi.resetAllMocks() in the outer beforeEach wipes the mock
        // implementations set in the vi.mock() factories above — restore
        // healthy-run defaults for a zero-episode sync (no matched/new items,
        // so only the initial sync_logs insert and the final update run).
        vi.mocked(getAccessToken).mockResolvedValue('mock-access-token')
        vi.mocked(fetchSavedEpisodes).mockResolvedValue([])
        vi.mocked(fetchUnsavedQueueEpisodes).mockResolvedValue([])
        vi.mocked(recoverShowGaps).mockResolvedValue({
          recovered: [],
          report: { shows_scanned: 0, missing: 0, saved: 0, by_show: {}, episodes: [] },
        })
        setupSyncLogsMock()
      })

      it('reports an unhandled sync error to the log service', async () => {
        // Arrange a rejection that reaches the outer catch.
        vi.mocked(getAccessToken).mockRejectedValue(new Error('token fetch failed'))

        await GET(createRequest(MOCK_SECRET))

        expect(mockLogError).toHaveBeenCalledWith('spotify-sync', expect.anything(), expect.anything())
      })

      it('labels a refresh-token DB read failure as a database error, not an auth error', async () => {
        // ops issue #334: a transient app_settings blip must
        // not file an alert that reads like a Spotify token problem.
        vi.mocked(getAccessToken).mockRejectedValue(
          new SpotifyAuthError(
            'Could not read the Spotify refresh token from the database (TypeError: fetch failed)',
            undefined,
            'refresh_token_unavailable',
          ),
        )

        const response = await GET(createRequest(MOCK_SECRET))
        const body = await response.json()

        expect(response.status).toBe(500)
        expect(body.error).toMatch(/^Database error: Could not read the Spotify refresh token/)
        expect(mockLogError).toHaveBeenCalledWith(
          'spotify-sync',
          expect.stringMatching(/^Database error: /),
          expect.anything(),
        )
      })

      it('reports a success-path sync_logs update failure', async () => {
        // Healthy run but sync_logs .update returns { error: {...} }.
        setupSyncLogsMock({ updateError: { message: 'boom' } })

        await GET(createRequest(MOCK_SECRET))

        expect(mockLogError).toHaveBeenCalledWith(
          'spotify-sync',
          expect.anything(),
          expect.objectContaining({ blindSpot: 'sync_logs-write' }),
        )
      })

      it('logs a Spotify 5xx that survived the client retries at warn, still recording the run as errored (#342)', async () => {
        vi.mocked(fetchSavedEpisodes).mockRejectedValue(
          new SpotifyApiError('Spotify API error: Bad Gateway', 502),
        )

        const response = await GET(createRequest(MOCK_SECRET))
        const body = await response.json()

        expect(response.status).toBe(500)
        expect(body.error).toBe('API error: Spotify API error: Bad Gateway')
        expect(mockLogWarn).toHaveBeenCalledWith(
          'spotify-sync',
          'API error: Spotify API error: Bad Gateway',
          expect.objectContaining({ statusCode: 500, spotifyStatus: 502, syncLogId: 1 }),
        )
        expect(mockLogError).not.toHaveBeenCalled()
        expect(syncLogUpdates).toContainEqual(
          expect.objectContaining({
            status: 'error',
            error_message: 'API error: Spotify API error: Bad Gateway',
          }),
        )
      })

      it('keeps a non-5xx Spotify API error at error level (#342)', async () => {
        vi.mocked(fetchSavedEpisodes).mockRejectedValue(
          new SpotifyApiError('Spotify API error: Unauthorized', 401),
        )

        await GET(createRequest(MOCK_SECRET))

        expect(mockLogError).toHaveBeenCalledWith(
          'spotify-sync',
          'API error: Spotify API error: Unauthorized',
          expect.anything(),
        )
        expect(mockLogWarn).not.toHaveBeenCalled()
      })

      it('keeps a Spotify auth failure at error level (#342)', async () => {
        vi.mocked(getAccessToken).mockRejectedValue(
          new SpotifyAuthError('Refresh token expired or revoked', 400, 'invalid_grant'),
        )

        await GET(createRequest(MOCK_SECRET))

        expect(mockLogError).toHaveBeenCalledWith(
          'spotify-sync',
          expect.stringMatching(/^Auth error: /),
          expect.anything(),
        )
        expect(mockLogWarn).not.toHaveBeenCalled()
      })

      it('does not log on a healthy run', async () => {
        await GET(createRequest(MOCK_SECRET))

        expect(mockLogError).not.toHaveBeenCalled()
      })
    })
  })
})
