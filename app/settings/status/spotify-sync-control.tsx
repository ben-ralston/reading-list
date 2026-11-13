'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { fetchWithRetry } from '@/lib/fetch-with-retry'
import { LAST_SPOTIFY_SYNC_KEY } from '@/lib/spotify/sync-cooldown'
import { SpotifySyncButton } from '@/components/spotify-sync-button'
import type { SyncResult } from '@/lib/types'

// Manual Spotify sync trigger for the Status page. Mirrors the home page's
// performSpotifySync (home-client.tsx) but, since there is no queue on this
// page, it refreshes the route to update the run history instead.
export function SpotifySyncControl() {
  const router = useRouter()
  const [isSyncing, setIsSyncing] = useState(false)

  const handleSync = async (): Promise<SyncResult | null> => {
    if (isSyncing) return null
    setIsSyncing(true)
    try {
      // Spotify sync is long-running and non-idempotent — do not retry.
      const response = await fetchWithRetry('/api/cron/spotify-sync', undefined, { retries: 0 })
      const result: SyncResult = await response.json()

      if (response.ok && result.success) {
        // Record the cooldown timestamp the home auto-sync engine reads, so a
        // manual sync here suppresses a redundant auto-sync right after
        // (parity with the home page's performSpotifySync).
        localStorage.setItem(LAST_SPOTIFY_SYNC_KEY, Date.now().toString())

        // No queue on this page — refresh the route to update the run history.
        if (result.created > 0 || result.updated > 0) {
          router.refresh()
        }
      }

      return result
    } catch (error) {
      return {
        success: false,
        processed: 0,
        created: 0,
        updated: 0,
        skipped: 0,
        error: error instanceof Error ? error.message : 'Network error',
      }
    } finally {
      setIsSyncing(false)
    }
  }

  return <SpotifySyncButton isSyncing={isSyncing} onSync={handleSync} />
}
