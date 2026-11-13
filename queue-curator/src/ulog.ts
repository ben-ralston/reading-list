// Unified-logger wrapper for the queue-curator job, the same documented
// exception as awc-agent/src/ulog.ts: lib/logger/index.ts no-ops off Vercel
// and this process runs on the owner's Mac. Error rows become alerts
// , so message strings are FIXED and variables go in jsonExtra.
// Best-effort: never throws, and the caller should give it a moment to send
// before the process exits.
import { log, type Level } from '../../lib/logger/logger'

export function sendAlert(message: string, extra: Record<string, unknown>): Promise<unknown> {
  try {
    return Promise.resolve(log('reading-list', 'error' as Level, message, { source: 'queue-curator', jsonExtra: extra })).catch(() => {})
  } catch {
    return Promise.resolve()
  }
}
