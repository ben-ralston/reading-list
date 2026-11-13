// Parses and validates the curator's answer from `claude --print
// --output-format stream-json --json-schema …`. Fails closed: the run is
// good only when at least one pick names a real candidate. Reasons are
// influenced by feed text and end up on the home screen, so they are kept
// to one short clean line or dropped.
import { MAX_PICKS, MAX_REASON_CHARS } from './prompt'
import { oneLine } from './text'

export interface Pick {
  id: number
  reason: string | null
}

export type PicksResult =
  | { ok: true; picks: Pick[]; dropped: string[] }
  | { ok: false; error: string }

export const PICKS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['picks'],
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'reason'],
        properties: { id: { type: 'integer' }, reason: { type: 'string' } },
      },
    },
  },
} as const

const FENCED_JSON = /`{3}(?:json)?\s*(\{[\s\S]*?\})\s*`{3}/g

// Without structured_output, take the last fenced JSON block, else the
// outermost {...} span of the text (same approach as awc-agent's result.ts).
function jsonFromText(text: string): unknown {
  const fenced = [...text.matchAll(FENCED_JSON)].pop()?.[1]
  const start = text.indexOf('{')
  const candidate = fenced ?? (start === -1 ? '' : text.slice(start, text.lastIndexOf('}') + 1))
  if (!candidate) return null
  try {
    return JSON.parse(candidate)
  } catch {
    return null
  }
}

function cleanReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const cleaned = oneLine(raw)
  return cleaned.length === 0 || cleaned.length > MAX_REASON_CHARS ? null : cleaned
}

export function validatePicks(raw: unknown, candidateIds: ReadonlySet<number>): PicksResult {
  const list = raw && typeof raw === 'object' ? (raw as { picks?: unknown }).picks : null
  if (!Array.isArray(list)) return { ok: false, error: 'claude answer has no picks list' }

  const picks: Pick[] = []
  const dropped: string[] = []
  const seen = new Set<number>()
  for (const entry of list) {
    const id = entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : undefined
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      dropped.push('entry without an integer id')
    } else if (!candidateIds.has(id)) {
      dropped.push(`id ${id} is not in the queue`)
    } else if (seen.has(id)) {
      dropped.push(`id ${id} repeated`)
    } else if (picks.length < MAX_PICKS) {
      seen.add(id)
      picks.push({ id, reason: cleanReason((entry as { reason?: unknown }).reason) })
    }
  }
  if (picks.length === 0) return { ok: false, error: 'claude answer has no valid picks' }
  return { ok: true, picks, dropped }
}

export function parsePicks(streamJson: string, candidateIds: ReadonlySet<number>): PicksResult {
  let resultEvent: Record<string, unknown> | null = null
  for (const line of streamJson.split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as Record<string, unknown>
      if (event && typeof event === 'object' && event.type === 'result') resultEvent = event
    } catch {
      // Non-JSON noise on stdout.
    }
  }
  if (!resultEvent) return { ok: false, error: 'claude produced no result' }
  if (resultEvent.subtype !== 'success') return { ok: false, error: `claude ended: ${String(resultEvent.subtype)}` }
  if (resultEvent.structured_output && typeof resultEvent.structured_output === 'object') {
    return validatePicks(resultEvent.structured_output, candidateIds)
  }
  const fromText = typeof resultEvent.result === 'string' ? jsonFromText(resultEvent.result) : null
  return fromText ? validatePicks(fromText, candidateIds) : { ok: false, error: 'claude produced no result' }
}

// Tool-enabled mode: the agent writes its answer to picks.json in its
// working folder. Same validation; a missing or broken file fails the run.
export function parsePicksFile(text: string | null, candidateIds: ReadonlySet<number>): PicksResult {
  if (text === null) return { ok: false, error: 'the agent wrote no picks.json' }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: 'picks.json is not valid JSON' }
  }
  return validatePicks(raw, candidateIds)
}
