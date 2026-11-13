// Unified-logger wrapper for the awc-agent daemon (#317). This is the one
// documented exception to "app code imports lib/logger/index.ts only":
// index.ts no-ops off Vercel, and this process runs on the owner's Mac. Errors
// become alerts, so message
// strings are FIXED and variables go in jsonExtra; repeats within a minute
// are suppressed so a persistent fault can't write a row every 5 s.
import { log, type Level } from '../../lib/logger/logger'

type UlogLevel = 'info' | 'warn' | 'error'
export type Ulog = Record<UlogLevel, (message: string, extra?: Record<string, unknown>) => void>

export function defaultSend(level: UlogLevel, message: string, extra?: Record<string, unknown>): Promise<boolean> {
  return log('reading-list', level as Level, message, { source: 'awc-agent', jsonExtra: extra })
}

export function createUlog(deps: {
  send: (level: UlogLevel, message: string, extra?: Record<string, unknown>) => Promise<unknown>
  nowMs: () => number
  minIntervalMs?: number
}): Ulog {
  const minInterval = deps.minIntervalMs ?? 60_000
  const lastSent = new Map<string, number>()
  const emit = (level: UlogLevel) => (message: string, extra?: Record<string, unknown>) => {
    const key = `${level}\u0000${message}`
    const now = deps.nowMs()
    const prev = lastSent.get(key)
    if (prev !== undefined && now - prev < minInterval) return
    lastSent.set(key, now)
    try {
      void Promise.resolve(deps.send(level, message, extra)).catch(() => {})
    } catch {
      // Logging is best-effort.
    }
  }
  return { info: emit('info'), warn: emit('warn'), error: emit('error') }
}
