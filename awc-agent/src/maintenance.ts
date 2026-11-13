// Daemon housekeeping on its own timer (#317 review): the heartbeat and the
// askwhocasts-sync nudge must keep running while a conversion holds the
// claim loop for up to 25 minutes — otherwise every real conversion would
// read as "Mac offline" and lose its sync nudges.
import { createFailureStreak, isTransientNetworkError } from './failure-streak'
import { errorText } from './result'
import type { Ulog } from './ulog'

export interface MaintenanceDeps {
  writeHeartbeat: (nowIso: string) => Promise<void>
  countRecentGenerating: (sinceIso: string) => Promise<number>
  nudger: { maybeNudge(count: number): Promise<boolean> }
  ulog: Ulog
  statusLine: (line: string) => void
  nowMs: () => number
}

const NUDGE_WINDOW_MS = 45 * 60_000

export function createMaintenance(deps: MaintenanceDeps) {
  let running = false
  // #366: warn on a blip, escalate after 10 min. After one "retrying" line
  // the log goes quiet, so a missing "heartbeat ok" still trips a log watcher's
  // 3-minute staleness check in the meantime.
  const heartbeatStreak = createFailureStreak({
    ulog: deps.ulog,
    nowMs: deps.nowMs,
    failedMessage: 'awc heartbeat failed',
    recoveredMessage: 'awc heartbeat recovered',
  })
  return {
    async tick(): Promise<void> {
      // A hung DB call must not stack up overlapping ticks.
      if (running) return
      running = true
      try {
        const now = deps.nowMs()
        const iso = new Date(now).toISOString()
        try {
          await deps.writeHeartbeat(iso)
          heartbeatStreak.ok()
          deps.statusLine(`heartbeat ok ${iso}`)
        } catch (error) {
          const message = errorText(error)
          if (!isTransientNetworkError(message)) {
            deps.ulog.error('awc heartbeat failed', { error: message })
            deps.statusLine(`heartbeat FAILED: ${message}`)
          } else {
            const { first, escalated } = heartbeatStreak.fail({ error: message })
            if (escalated) deps.statusLine(`heartbeat FAILED: ${message}`)
            else if (first) deps.statusLine(`heartbeat retrying: ${message}`)
          }
        }
        try {
          const generating = await deps.countRecentGenerating(new Date(now - NUDGE_WINDOW_MS).toISOString())
          await deps.nudger.maybeNudge(generating)
        } catch (error) {
          deps.ulog.warn('awc sync nudge check failed', { error: errorText(error) })
        }
      } finally {
        running = false
      }
    },
  }
}
