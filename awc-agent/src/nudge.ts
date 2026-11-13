// While an episode is generating, poke the askwhocasts-sync route every 2 min
// so it attaches in minutes instead of waiting for the :05/:20/:35/:50 cron.
import { errorText } from './result'

const NUDGE_TIMEOUT_MS = 15_000

export function createNudger(deps: {
  fetch: typeof fetch
  deployUrl: string
  secret: string
  nowMs: () => number
  intervalMs?: number
  // Non-2xx (e.g. 401 after a SYNC_API_SECRET rotation) or network failure.
  onFailure?: (reason: string) => void
}) {
  const interval = deps.intervalMs ?? 120_000
  let last = -Infinity
  return {
    async maybeNudge(generatingCount: number): Promise<boolean> {
      if (generatingCount === 0 || deps.nowMs() - last < interval) return false
      last = deps.nowMs()
      try {
        const res = await deps.fetch(`${deps.deployUrl}/api/cron/askwhocasts-sync`, {
          headers: { Authorization: `Bearer ${deps.secret}` },
          signal: AbortSignal.timeout(NUDGE_TIMEOUT_MS),
        })
        if (!res.ok) {
          deps.onFailure?.(`HTTP ${res.status}`)
          return false
        }
        return true
      } catch (error) {
        deps.onFailure?.(errorText(error))
        return false
      }
    },
  }
}
