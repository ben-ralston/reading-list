"use client"

// Shared state and actions for the feed's two views (#377): home (the picks)
// and /everything (the pile). Holds every active feed item, the latest curator
// run and the clock the shortlist is computed against. The clock starts at the
// server's render time so SSR and hydration agree, and moves on every reload
// and pin / dismiss.
//
// Actions are optimistic and lock per item. A failure rolls back only the
// item it touched, so it can't undo another action that succeeded meanwhile.

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import {
  type QueueItem,
  fetchFeedHome,
  updateItemStatus,
  pinItem,
  dismissItem,
  markSentToReader,
  requestAwcConversion,
} from "@/lib/queue-client"
import {
  applyComplete,
  applyToggleStarted,
  applyStartItem,
  applyMarkSentToReader,
  applyAwcQueued,
  applyAwcRequestResult,
  applyPin,
  applyDismiss,
} from "@/lib/queue-mutations"
import type { Curation } from "@/lib/shortlist"
import { sendToElevenReader, iosShortcutLaunchUrl } from "@/lib/reader/elevenreader"
import { sendToAskwhoCasts } from "@/lib/reader/askwhocasts"
import { articleSource } from "@/lib/awc/eligibility"
import { useAwcConversionPolling, type AwcAgentStatus } from "@/lib/awc/polling"
import type { AwcKind } from "@/lib/awc/stages"
import { AWAITING_COMMENTS, isStartedStatus } from "@/lib/content-status"

export interface FeedQueueInit {
  items: QueueItem[]
  curation: Curation | null
  nowMs: number
}

type ItemAction = (item: QueueItem) => Promise<void>

export interface FeedQueueActions {
  onMarkComplete: ItemAction
  onSkip: ItemAction
  onToggleStarted: ItemAction
  onStartItem: ItemAction
  // Resolve true when the server accepted the change, false when it was
  // refused (and rolled back) or blocked by a pending action on the item.
  onPin: (item: QueueItem) => Promise<boolean>
  onNotNow: (item: QueueItem) => Promise<boolean>
  onListen: ItemAction
  onConvert: (item: QueueItem, kind?: AwcKind) => Promise<void>
  onConvertManually: ItemAction
}

export interface FeedQueue {
  items: QueueItem[]
  curation: Curation | null
  nowMs: number
  error: string | null
  // background: a refresh nobody asked for (tab refocus, sync, an episode
  // attaching). Its failure is logged only, so good data stays on screen.
  loadQueue: (opts?: { background?: boolean }) => Promise<void>
  hasPendingAction: () => boolean
  awcAgent: AwcAgentStatus
  actions: FeedQueueActions
}

// Put back one item's pre-action state: replace it if it's still there,
// re-insert it near its old index if the action had removed it.
function putBack(items: QueueItem[], previous: QueueItem, previousIndex: number): QueueItem[] {
  const index = items.findIndex(item => item.id === previous.id)
  if (index >= 0) return items.map(item => (item.id === previous.id ? previous : item))
  const next = [...items]
  next.splice(Math.min(previousIndex, next.length), 0, previous)
  return next
}

export function useFeedQueue(init: FeedQueueInit): FeedQueue {
  const [items, setItems] = useState<QueueItem[]>(init.items)
  const [curation, setCuration] = useState<Curation | null>(init.curation)
  const [nowMs, setNowMs] = useState(init.nowMs)
  const [error, setError] = useState<string | null>(null)

  const actionLock = useRef(new Set<string>())
  // Ordinal of the last action started per item, so a reload can tell which
  // items changed locally after its fetch began.
  const actionSeq = useRef(0)
  const lastActionAt = useRef(new Map<number, number>())
  const itemsRef = useRef(items)
  useEffect(() => { itemsRef.current = items }, [items])

  const pendingIds = () =>
    [...actionLock.current].map(key => Number(key.slice('item-'.length)))

  const loadQueue = useCallback(async (opts?: { background?: boolean }) => {
    const startSeq = actionSeq.current
    const pendingAtStart = pendingIds()
    try {
      const data = await fetchFeedHome()
      // Items touched locally around this fetch keep their local state: the
      // snapshot may predate their write, and nothing re-applies it after.
      // That is anything pending when the fetch began or ended, or started
      // while it was in flight.
      const pending = new Set([...pendingAtStart, ...pendingIds()])
      for (const [id, seq] of lastActionAt.current) {
        if (seq > startSeq) pending.add(id)
      }
      const current = new Map(itemsRef.current.map(item => [item.id, item]))
      setItems(
        pending.size === 0
          ? data.items
          : data.items.flatMap(item => {
              if (!pending.has(item.id)) return [item]
              const local = current.get(item.id)
              return local ? [local] : []
            }),
      )
      setCuration(data.curation)
      setNowMs(Date.now())
      setError(null)
    } catch (err) {
      if (opts?.background) {
        console.warn('[Feed] Background reload failed:', err)
        return
      }
      setError("Failed to load queue. Please check your connection.")
      toast.error("Failed to load queue. Please check your connection.")
      console.error(err)
    }
  }, [])

  const hasPendingAction = useCallback(() => actionLock.current.size > 0, [])

  const runOptimisticAction = useCallback(async (
    itemId: number,
    actionName: string,
    transform: (items: QueueItem[]) => QueueItem[],
    apiCall: () => Promise<void>,
  ): Promise<boolean> => {
    const lockKey = `item-${itemId}`
    if (actionLock.current.has(lockKey)) {
      toast.info("Please wait — previous action still in progress")
      return false
    }
    actionLock.current.add(lockKey)
    actionSeq.current += 1
    lastActionAt.current.set(itemId, actionSeq.current)
    const previousIndex = itemsRef.current.findIndex(item => item.id === itemId)
    const previous = previousIndex >= 0 ? itemsRef.current[previousIndex] : undefined
    setItems(transform)
    try {
      await apiCall()
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : `Failed to ${actionName}`
      console.error(`Failed to ${actionName}:`, err)
      toast.error(message)
      if (previous) setItems(current => putBack(current, previous, previousIndex))
      return false
    } finally {
      actionLock.current.delete(lockKey)
    }
  }, [])

  const onMarkComplete = useCallback(async (item: QueueItem) => {
    await runOptimisticAction(item.id, "mark complete",
      q => applyComplete(q, item.id),
      () => updateItemStatus(item.id, "Completed"),
    )
  }, [runOptimisticAction])

  const onSkip = useCallback(async (item: QueueItem) => {
    await runOptimisticAction(item.id, "skip item",
      q => applyComplete(q, item.id),
      () => updateItemStatus(item.id, "Skip"),
    )
  }, [runOptimisticAction])

  const onToggleStarted = useCallback(async (item: QueueItem) => {
    if (item.status === AWAITING_COMMENTS) return
    const newStatus = item.status === "In Progress" ? "" : "In Progress"
    await runOptimisticAction(item.id, "update status",
      q => applyToggleStarted(q, item.id, item.status),
      () => updateItemStatus(item.id, newStatus),
    )
  }, [runOptimisticAction])

  // Start/Resume or any source link: idempotent "In Progress".
  const onStartItem = useCallback(async (item: QueueItem) => {
    if (isStartedStatus(item.status)) return
    await runOptimisticAction(item.id, "start item",
      q => applyStartItem(q, item.id),
      () => updateItemStatus(item.id, "In Progress"),
    )
  }, [runOptimisticAction])

  const onPin = useCallback((item: QueueItem) => {
    const now = Date.now()
    setNowMs(now)
    return runOptimisticAction(item.id, "pin item",
      q => applyPin(q, item.id, new Date(now).toISOString()),
      () => pinItem(item.id),
    )
  }, [runOptimisticAction])

  const onNotNow = useCallback((item: QueueItem) => {
    const now = Date.now()
    setNowMs(now)
    return runOptimisticAction(item.id, "move item off the shortlist",
      q => applyDismiss(q, item.id, new Date(now).toISOString()),
      () => dismissItem(item.id),
    )
  }, [runOptimisticAction])

  // #171: hand a text item to ElevenReader (share sheet on mobile, copy + open
  // on desktop), then persist a "sent" timestamp. Cancelled share => no-op.
  const onListen = useCallback(async (item: QueueItem) => {
    if (!item.link) return
    // "Listen again": already sent → on iOS just relaunch the app via the
    // user's Shortcut (see #171 spike); off iOS fall through to the handoff.
    if (item.sentToReaderAt) {
      const launchUrl = iosShortcutLaunchUrl()
      if (launchUrl) {
        window.location.href = launchUrl
        return
      }
    }
    const result = await sendToElevenReader(item.link)
    if (result === 'cancelled') return
    if (result === 'opened') {
      toast('Opened ElevenReader — copy the link to paste it in')
      return
    }
    if (result === 'copied') {
      toast.success('Link copied — paste it into ElevenReader')
    }
    await runOptimisticAction(item.id, "mark sent to ElevenReader",
      q => applyMarkSentToReader(q, item.id, new Date().toISOString()),
      () => markSentToReader(item.id),
    )
  }, [runOptimisticAction])

  // #317: hand the item to the Mac agent (awc-agent/), which submits it to
  // Askwho Casts; the polling hook below merges its stages in. After a
  // failure the same action queues a fresh request (Retry).
  const onConvert = useCallback(async (item: QueueItem, kind: AwcKind = "article") => {
    if (kind === "article" && !articleSource(item)) return
    let reconcile = false
    await runOptimisticAction(item.id, "send to Askwho Casts agent",
      q => applyAwcQueued(q, item.id, new Date().toISOString(), kind),
      async () => {
        const { conversion, alreadyActive } = await requestAwcConversion(item.id, kind)
        if (conversion) {
          setItems(q => applyAwcRequestResult(q, item.id, conversion))
        } else {
          // 409 but that request finished in between: reload real state.
          reconcile = true
        }
        if (alreadyActive) toast.info("Already converting with Askwho Casts")
        else toast.success("Sent to Askwho Casts agent")
      },
    )
    // After the action has released its lock, so the reload replaces the
    // optimistic "queued" placeholder instead of preserving it.
    if (reconcile) loadQueue({ background: true })
  }, [runOptimisticAction, loadQueue])

  // #226 copy + open handoff, the manual fallback after a failed agent run.
  const onConvertManually = useCallback(async (item: QueueItem) => {
    const link = articleSource(item)?.link
    if (!link) return
    const result = await sendToAskwhoCasts(link)
    if (result === 'opened') {
      toast('Opened Askwho Casts — copy the link to paste it in')
      return
    }
    toast.success('Link copied — paste it into Askwho Casts')
  }, [])

  // #317: live conversion stages; reload once an episode attaches so the new
  // audio source (and the hidden Convert action) show up.
  const handleEpisodeReady = useCallback(() => { loadQueue({ background: true }) }, [loadQueue])
  const awcAgent = useAwcConversionPolling({
    queue: items, setQueue: setItems, onEpisodeReady: handleEpisodeReady,
  })

  return {
    items,
    curation,
    nowMs,
    error,
    loadQueue,
    hasPendingAction,
    awcAgent,
    actions: {
      onMarkComplete, onSkip, onToggleStarted, onStartItem, onPin, onNotNow,
      onListen, onConvert, onConvertManually,
    },
  }
}
