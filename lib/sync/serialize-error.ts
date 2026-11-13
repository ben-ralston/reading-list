/**
 * Serialize an unknown thrown value into a queryable shape suitable for
 * sync_logs.error_message (text) and sync_logs.metadata (jsonb).
 *
 * Three cases come up in this codebase:
 *  - `Error` instances thrown by app code or fetch (e.g. TypeError wrapping
 *    a HeadersOverflowError). Walks the .cause chain so the root cause
 *    lands in error_message.
 *  - PostgrestError-shaped objects from supabase-js: `{ message, code, hint,
 *    details }`. These are NOT `instanceof Error` and were previously
 *    serialized as "Unknown error", losing all debugging context.
 *  - Anything else — falls back to safe stringification.
 */

export interface SerializedErrorDetails {
  code?: string
  hint?: string
  details?: string
}

export interface SerializedError {
  message: string
  details: SerializedErrorDetails | null
}

const MAX_CAUSE_DEPTH = 4

export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    let message = `${err.name}: ${err.message}`
    let cause: unknown = (err as Error & { cause?: unknown }).cause
    for (let depth = 0; cause !== undefined && depth < MAX_CAUSE_DEPTH; depth++) {
      if (cause instanceof Error) {
        message += `\nCaused by: ${cause.name}: ${cause.message}`
        cause = (cause as Error & { cause?: unknown }).cause
      } else {
        message += `\nCaused by: ${safeString(cause)}`
        break
      }
    }
    return { message, details: null }
  }

  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>
    if (typeof obj.message === 'string') {
      const details: SerializedErrorDetails = {}
      if (typeof obj.code === 'string' && obj.code !== '') details.code = obj.code
      if (typeof obj.hint === 'string' && obj.hint !== '') details.hint = obj.hint
      if (typeof obj.details === 'string' && obj.details !== '') details.details = obj.details
      return {
        message: obj.message,
        details: Object.keys(details).length > 0 ? details : null,
      }
    }
  }

  return { message: safeString(err), details: null }
}

function safeString(value: unknown): string {
  if (value === null || value === undefined) return 'Unknown error'
  if (typeof value === 'string') return value || 'Unknown error'
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
