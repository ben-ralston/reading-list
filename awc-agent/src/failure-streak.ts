// Warn first, escalate later (#366). The daemon's claim poll and heartbeat
// hit Supabase over the network; a short blip used to log at error and open
// an alert per burst. A streak now logs at warn, sends ONE
// error once it has lasted ESCALATE_AFTER_MS, and logs recovery once at info.
//
// A streak is a run of failures no more than QUIET_MS apart. Successes in
// between don't end it (a fault that fails every other call still
// escalates), and a gap longer than QUIET_MS does: the Mac sleeping overnight
// between two failures is not eight hours of failing.
import type { Ulog } from './ulog'

export const ESCALATE_AFTER_MS = 10 * 60_000
export const QUIET_MS = 3 * 60_000

// Transport failures only (the 128 rows behind #366/#367 were all
// "TypeError: fetch failed"). Anything else, such as a missing RPC or a
// permission error, will not clear by itself and stays an error at once.
const TRANSIENT = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i
export const isTransientNetworkError = (message: string) => TRANSIENT.test(message)

export interface FailureStreak {
  // first: this failure opened a streak. escalated: the streak has sent its error.
  fail(extra: Record<string, unknown>): { first: boolean; escalated: boolean }
  // true when this success ended a streak (recovery was just logged).
  ok(): boolean
}

export function createFailureStreak(deps: {
  ulog: Ulog
  nowMs: () => number
  failedMessage: string
  recoveredMessage: string
}): FailureStreak {
  let startedAt: number | null = null
  let lastFailAt = 0
  let failures = 0
  let escalated = false
  const reset = () => { startedAt = null; failures = 0; escalated = false }
  return {
    fail(extra) {
      const now = deps.nowMs()
      if (startedAt !== null && now - lastFailAt > QUIET_MS) reset()
      const first = startedAt === null
      if (first) startedAt = now
      lastFailAt = now
      failures += 1
      if (escalated) return { first, escalated }
      const elapsed = now - startedAt!
      if (elapsed >= ESCALATE_AFTER_MS) {
        escalated = true
        deps.ulog.error(deps.failedMessage, { ...extra, failures, failingForSec: Math.round(elapsed / 1000) })
        return { first, escalated }
      }
      deps.ulog.warn(deps.failedMessage, extra)
      return { first, escalated }
    },
    ok() {
      if (startedAt === null || deps.nowMs() - lastFailAt < QUIET_MS) return false
      deps.ulog.info(deps.recoveredMessage, {
        failures,
        failedForSec: Math.round((lastFailAt - startedAt) / 1000),
        escalated,
      })
      reset()
      return true
    },
  }
}
