/**
 * Bounded per-item failure sampler for sync routes (#337).
 *
 * `/api/sync` used to report only a count when item writes threw, so the
 * alert `all N item write(s) failed; nothing persisted` carried no
 * source, no item count and no Postgres error code — the 2026-09-14 outage
 * could not even be attributed to a caller. This collector keeps the first few
 * failures (title + serialized error) and the distinct set of error codes, so
 * both the alert's json_extra and sync_logs.metadata say what actually broke.
 *
 * Bounded on purpose: the log service caps `message` but passes json_extra
 * through uncapped, and an oversized event is rejected outright (silently
 * dropped), which is the opposite of what an outage report needs.
 *
 * Titles are not secrets for /api/sync callers (Substack/Audible). If a route
 * whose item titles or messages can carry secrets (rss-sync's feed URLs)
 * adopts this, redact before calling `record`.
 */
import { serializeError } from './serialize-error'

export const MAX_ITEM_ERROR_SAMPLES = 3
export const MAX_SAMPLE_TITLE_LENGTH = 80
export const MAX_SAMPLE_MESSAGE_LENGTH = 300

export interface ItemErrorSample {
  title: string
  code?: string
  message: string
}

export interface ItemErrorSummary {
  itemErrors: number
  /** Distinct Postgres/PostgREST codes in first-seen order (e.g. '40P01'). */
  codes: string[]
  samples: ItemErrorSample[]
}

export interface ItemErrorCollector {
  /** Number of failures recorded so far. */
  readonly count: number
  record(title: unknown, err: unknown): void
  summary(): ItemErrorSummary
}

export function createItemErrorCollector(): ItemErrorCollector {
  let count = 0
  const codes: string[] = []
  const samples: ItemErrorSample[] = []

  return {
    get count() {
      return count
    },
    record(title, err) {
      count++
      const serialized = serializeError(err)
      const code = serialized.details?.code
      if (code && !codes.includes(code)) codes.push(code)
      if (samples.length < MAX_ITEM_ERROR_SAMPLES) {
        samples.push({
          // Payloads are untrusted JSON: a non-string title must not turn a
          // per-item failure into a thrown TypeError that aborts the batch.
          title: String(title ?? '').slice(0, MAX_SAMPLE_TITLE_LENGTH),
          ...(code && { code }),
          message: serialized.message.slice(0, MAX_SAMPLE_MESSAGE_LENGTH),
        })
      }
    },
    summary() {
      return { itemErrors: count, codes: [...codes], samples: samples.map((s) => ({ ...s })) }
    },
  }
}
