'use client'
// Live status for Askwho Casts conversions (#317): while any queue item has an
// active conversion, poll /api/awc-conversions and merge stages into the queue.
import { useEffect, useRef, useState } from 'react'
import type { QueueItem } from '@/lib/queue-client'
import { AWC_HEARTBEAT_STALE_SECONDS, isActiveStage, type AwcConversionSummary } from './stages'

export interface AwcPollPayload {
  conversions: Array<AwcConversionSummary & { contentItemId: number }>
  heartbeatAgeSeconds: number | null
}

// Agent health as of the last poll. checkedAt (ms) doubles as the clock for
// the "Mac offline" age check, so rendering never reads Date.now().
export interface AwcAgentStatus {
  stale: boolean
  checkedAt: number
}

export function hasActiveConversion(queue: QueueItem[]): boolean {
  return queue.some((i) => isActiveStage(i.awcConversion?.status))
}

export function mergeAwcPoll(queue: QueueItem[], payload: AwcPollPayload) {
  // Newest row per item wins (rows arrive ordered by id ascending).
  const byItem = new Map<number, AwcConversionSummary & { contentItemId: number }>()
  for (const c of payload.conversions) byItem.set(c.contentItemId, c)
  let needsRefresh = false
  const next = queue.map((item) => {
    if (!isActiveStage(item.awcConversion?.status)) return item
    const local = item.awcConversion!
    const polled = byItem.get(item.id)
    // Not visible yet (optimistic insert racing the poll) — keep local state.
    if (!polled) return item
    // While the POST is still in flight (id -1) the only row the poll can see
    // for this item is an older, finished one (one active row per item) —
    // e.g. the failure being retried. Wait for the new active row.
    if (local.id === -1 && !isActiveStage(polled.status)) return item
    // Never step back to a row older than the one the card already tracks.
    if (local.id > 0 && polled.id < local.id) return item
    if (polled.status === 'done') {
      needsRefresh = true
      return { ...item, awcConversion: null }
    }
    const { contentItemId: _ignored, ...summary } = polled
    return { ...item, awcConversion: summary }
  })
  const age = payload.heartbeatAgeSeconds
  return { queue: next, needsRefresh, agentStale: age == null || age > AWC_HEARTBEAT_STALE_SECONDS }
}

export function useAwcConversionPolling({
  queue, setQueue, onEpisodeReady, intervalMs = 4000,
}: {
  queue: QueueItem[]
  setQueue: (f: (q: QueueItem[]) => QueueItem[]) => void
  onEpisodeReady: () => void
  intervalMs?: number
}): AwcAgentStatus {
  const [agent, setAgent] = useState<AwcAgentStatus>({ stale: false, checkedAt: 0 })
  const active = hasActiveConversion(queue)
  // Latest queue + callback for the polling tick. The queue ref lets side
  // effects be computed outside the setQueue updater (updaters stay pure).
  const onReadyRef = useRef(onEpisodeReady)
  const queueRef = useRef(queue)
  useEffect(() => {
    onReadyRef.current = onEpisodeReady
    queueRef.current = queue
  }, [onEpisodeReady, queue])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    const tick = async () => {
      try {
        const res = await fetch('/api/awc-conversions', { cache: 'no-store' })
        if (!res.ok || cancelled) return
        const payload = (await res.json()) as AwcPollPayload
        if (cancelled) return
        const { needsRefresh, agentStale: stale } = mergeAwcPoll(queueRef.current, payload)
        setQueue((q) => mergeAwcPoll(q, payload).queue)
        setAgent({ stale, checkedAt: Date.now() })
        if (needsRefresh) onReadyRef.current()
      } catch {
        // Transient network failure — the next tick retries.
      }
    }
    tick()
    const handle = setInterval(tick, intervalMs)
    return () => {
      cancelled = true
      clearInterval(handle)
    }
  }, [active, intervalMs, setQueue])

  return agent
}
