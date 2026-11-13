"use client"

// The feed home screen (#377): Claude's picks. Pins first, then the latest
// curator run's picks, then the Recommended formula, first HOME_SIZE shown
// and the top one as the hero. The pile lives at /everything.
//
// Items, picks and the shortlist clock live in useFeedQueue; buildShortlist
// orders them during render, on the server and in the browser alike. This
// file adds the home-only machinery: Spotify auto-sync (mount, tab refocus,
// 30-minute interval) and a reload when the tab comes back, so a new curator
// run reaches an open screen.

import { useEffect, useState, useCallback, useMemo, useRef } from "react"
import { type QueueItem } from "@/lib/queue-client"
import { fetchWithRetry } from "@/lib/fetch-with-retry"
import { type SyncResult } from "@/lib/types"
import { ReadingList } from "@/components/reading-list"
import { LAST_SPOTIFY_SYNC_KEY, SPOTIFY_SYNC_COOLDOWN } from "@/lib/spotify/sync-cooldown"
import { useFeedQueue } from "@/lib/use-feed-queue"
import { buildShortlist, curationFreshness, type Curation } from "@/lib/shortlist"

// Media-type helpers now live in @/lib/media-type (#171). Re-exported here so
// existing importers keep working.
export { hasMediaType, getMediaType } from "@/lib/media-type"
export type { MediaFilter, MediaType } from "@/lib/media-type"

// Coming back to the tab after this long reloads the feed and picks.
const REFOCUS_RELOAD_MS = 5 * 60 * 1000

interface HomeClientProps {
  initialItems: QueueItem[]
  initialCuration: Curation | null
  // The server's render time: the shortlist clock until the first reload.
  serverNow: number
}

export function HomeClient({ initialItems, initialCuration, serverNow }: HomeClientProps) {
  const { items, curation, nowMs, error, loadQueue, hasPendingAction, awcAgent, actions } =
    useFeedQueue({ items: initialItems, curation: initialCuration, nowMs: serverNow })
  const [isSyncing, setIsSyncing] = useState(false)
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)

  const shortlist = useMemo(() => buildShortlist(items, curation, nowMs), [items, curation, nowMs])
  const shortlistItems = useMemo(() => shortlist.map(entry => entry.item), [shortlist])
  const reasons = useMemo(
    () => new Map(shortlist.flatMap(e => (e.tier === 'pick' && e.reason ? [[e.item.id, e.reason] as const] : []))),
    [shortlist],
  )
  const freshness = useMemo(() => curationFreshness(curation, nowMs), [curation, nowMs])
  const everythingCount = items.length - shortlist.length

  // Shared Spotify sync function - used by auto-sync, refocus and interval.
  const performSpotifySync = useCallback(async (): Promise<SyncResult | null> => {
    if (isSyncing) return null

    setIsSyncing(true)
    try {
      // Spotify sync is long-running and non-idempotent — do not retry
      const response = await fetchWithRetry('/api/cron/spotify-sync', undefined, { retries: 0 })
      const result: SyncResult = await response.json()

      if (response.ok && result.success) {
        // Update cooldown timestamp (per-browser rate limiting)
        localStorage.setItem(LAST_SPOTIFY_SYNC_KEY, Date.now().toString())

        // Refresh if anything changed AND no optimistic update is in flight,
        // so a sync can't overwrite a pending action.
        if ((result.created > 0 || result.updated > 0) && !hasPendingAction()) {
          loadQueue({ background: true })
        }
      }

      return result
    } catch (error) {
      console.error('[Spotify Sync] Failed:', error)
      return {
        success: false,
        processed: 0,
        created: 0,
        updated: 0,
        skipped: 0,
        error: error instanceof Error ? error.message : 'Network error'
      }
    } finally {
      setIsSyncing(false)
    }
  }, [isSyncing, loadQueue, hasPendingAction])

  // Check if enough time has passed since last sync (respects 5-min cooldown)
  const shouldSync = useCallback(() => {
    const lastSync = localStorage.getItem(LAST_SPOTIFY_SYNC_KEY)
    if (!lastSync) return true
    const elapsed = Date.now() - parseInt(lastSync, 10)
    return elapsed >= SPOTIFY_SYNC_COOLDOWN
  }, [])

  // Defer the auto-sync by 2s on mount to keep it off the critical path
  useEffect(() => {
    const timer = setTimeout(async () => {
      if (!shouldSync()) {
        console.log('[Auto-Sync] Skipping - synced recently')
        return
      }

      console.log('[Auto-Sync] Starting Spotify sync...')
      const result = await performSpotifySync()
      if (result) {
        console.log('[Auto-Sync] Complete:', result)
      }
    }, 2000)

    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- Intentionally run only on mount
  }, [])

  // Periodic sync: visibility-change + 30-minute interval
  const hiddenAtRef = useRef<number | null>(null)
  // Keep refs to the latest functions so the long-lived effect always calls
  // the current versions (avoids a stale isSyncing closure)
  const performSyncRef = useRef(performSpotifySync)
  useEffect(() => { performSyncRef.current = performSpotifySync }, [performSpotifySync])
  const reloadRef = useRef(() => { loadQueue({ background: true }) })
  useEffect(() => {
    reloadRef.current = () => { loadQueue({ background: true }) }
  }, [loadQueue])

  useEffect(() => {
    const INTERVAL_MS = 30 * 60 * 1000 // 30 minutes

    const handleVisibilityChange = async () => {
      if (document.hidden) {
        hiddenAtRef.current = Date.now()
        return
      }

      const hiddenAt = hiddenAtRef.current
      hiddenAtRef.current = null
      if (!hiddenAt) return
      const hiddenFor = Date.now() - hiddenAt

      // Tab became visible again — sync if hidden for > 5 minutes and cooldown passed
      let syncReloaded = false
      if (hiddenFor >= SPOTIFY_SYNC_COOLDOWN && shouldSync()) {
        console.log('[Visibility Sync] Tab refocused after >5 min, syncing...')
        const result = await performSyncRef.current()
        if (result) {
          console.log('[Visibility Sync] Complete:', result)
          syncReloaded = result.success && (result.created > 0 || result.updated > 0)
        }
      }
      // #377: reload even when the sync changed nothing, so a newer curator
      // run and the freshness clock reach a screen that stayed open.
      if (hiddenFor >= REFOCUS_RELOAD_MS && !syncReloaded) reloadRef.current()
    }

    const intervalId = setInterval(async () => {
      if (!shouldSync()) return
      console.log('[Interval Sync] 30-min interval triggered, syncing...')
      const result = await performSyncRef.current()
      if (result) {
        console.log('[Interval Sync] Complete:', result)
      }
    }, INTERVAL_MS)

    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      clearInterval(intervalId)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- uses refs to avoid re-registering listeners/interval on every render
  }, [])

  const handleRefresh = useCallback(() => { loadQueue() }, [loadQueue])
  const handleEntryAdded = useCallback(() => { loadQueue({ background: true }) }, [loadQueue])

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="text-center">
          <p className="text-destructive text-lg font-medium">{error}</p>
          <button onClick={() => loadQueue()} className="mt-4 rounded-lg bg-primary px-6 py-2 text-primary-foreground">
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <main className="min-h-screen bg-background">
      <ReadingList
        view="home"
        items={shortlistItems}
        reasons={reasons}
        freshness={freshness}
        everythingCount={everythingCount}
        onMarkComplete={actions.onMarkComplete}
        onSkip={actions.onSkip}
        onToggleStarted={actions.onToggleStarted}
        onStartItem={actions.onStartItem}
        onMakeNext={actions.onPin}
        onNotNow={actions.onNotNow}
        onListen={actions.onListen}
        onConvert={actions.onConvert}
        onConvertManually={actions.onConvertManually}
        awcAgent={awcAgent}
        onRefresh={handleRefresh}
        isAddDialogOpen={isAddDialogOpen}
        onAddDialogOpenChange={setIsAddDialogOpen}
        onEntryAdded={handleEntryAdded}
      />
    </main>
  )
}
