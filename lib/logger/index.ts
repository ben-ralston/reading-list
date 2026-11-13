/**
 * Reading-list's interface to the log service (#269). App code imports
 * ONLY this module — never ./logger (the vendored shim) directly.
 *
 * Sends exclusively from Vercel production: local dev, scripts, and preview
 * deploys stay silent because the alerting job raises alerts from
 * error rows, and non-prod noise would raise spurious alerts.
 *
 * Server-side only (the shim uses node: builtins) — never import from
 * client components.
 */
import { log } from './logger'
import { serializeError } from '@/lib/sync/serialize-error'

export async function logError(
  context: string,
  error: unknown,
  extra?: Record<string, unknown>,
): Promise<void> {
  await send('error', context, error, extra)
}

/**
 * Same as logError, at warn level (#342). The alerting job raises alerts
 * from error/alert rows only, so use this for failures that are
 * expected to recur and fix themselves — e.g. an upstream 5xx that already
 * survived the client's retries — so they stay visible without filing issues.
 */
export async function logWarn(
  context: string,
  error: unknown,
  extra?: Record<string, unknown>,
): Promise<void> {
  await send('warn', context, error, extra)
}

async function send(
  level: 'error' | 'warn',
  context: string,
  error: unknown,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    if (process.env.VERCEL_ENV !== 'production') return
    const { message, details } = serializeError(error)
    const jsonExtra =
      details || extra ? { ...(details && { error: details }), ...extra } : undefined
    await log('reading-list', level, `[${context}] ${message}`, {
      ...(jsonExtra && { jsonExtra }),
      source: 'vercel-production',
    })
  } catch {
    // Best-effort by contract: logging must never break the caller.
  }
}
