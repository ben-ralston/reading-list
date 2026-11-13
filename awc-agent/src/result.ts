// Parses the final result of `claude --print --output-format stream-json
// --json-schema …` into an AgentResult (#317). Fails closed: anything
// missing or malformed becomes outcome 'failed' with a reason.
import type { AgentResult } from '../../lib/awc/conversions-repo'

export const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'path', 'episode_title', 'credits', 'reported_words', 'error'],
  properties: {
    outcome: { enum: ['generating', 'failed'] },
    path: { enum: ['url', 'script', null] },
    episode_title: { type: ['string', 'null'] },
    credits: { type: ['integer', 'null'] },
    reported_words: { type: ['integer', 'null'] },
    error: { type: ['string', 'null'] },
  },
} as const

interface RawResult {
  outcome?: unknown
  path?: unknown
  episode_title?: unknown
  credits?: unknown
  reported_words?: unknown
  error?: unknown
}

// The agent's error text is influenced by the pages it read, and it flows to
// the DB, the card tooltip and the log service (which can raise alerts): keep it
// one short line with no control characters.
export function boundError(text: string): string {
  const cleaned = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.length > 200 ? `${cleaned.slice(0, 199)}…` : cleaned
}

// Text for a caught error (#335). supabase-js rejects with a plain
// PostgrestError-shaped object ({message, code, details, hint}), which
// String() turns into "[object Object]"; postgrest may put a whole stack in
// `details`, and fetch puts the network reason in `cause`. Returns one short
// bounded line (it ends up in alerts); never throws.
export function errorText(error: unknown): string {
  return boundError(rawErrorText(error)) || 'unknown error'
}

const firstLine = (text: string) => text.split('\n')[0].trim()

function rawErrorText(error: unknown): string {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    const e = error as { message: string; name?: unknown; code?: unknown; details?: unknown; hint?: unknown; cause?: unknown }
    const isError = error instanceof Error
    const head = isError && e.name !== 'Error'
      ? (e.message ? `${String(e.name)}: ${e.message}` : String(e.name))
      : e.message || (isError ? 'Error' : '')
    const extras: string[] = []
    if (typeof e.code === 'string' && e.code) extras.push(`code: ${e.code}`)
    for (const key of ['details', 'hint'] as const) {
      const value = e[key]
      if (typeof value !== 'string') continue
      const line = firstLine(value)
      if (line && line !== firstLine(e.message) && line !== head) extras.push(`${key}: ${line}`)
    }
    const cause = e.cause as { message?: unknown } | undefined
    if (cause && typeof cause.message === 'string' && cause.message) extras.push(`cause: ${firstLine(cause.message)}`)
    return extras.length ? `${head} (${extras.join(', ')})` : head
  }
  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error) ?? String(error)
    } catch {
      return 'unserializable error object'
    }
  }
  return String(error)
}

// A complete article costs about 175 words a credit (runs 3, 13 and 16), so it
// scores about 0.85 of length / 150. 65% leaves room for dropped captions and
// footers; the summary this exists to catch (conversion 18) scored 0.21 (#363).
const MIN_COVERAGE = 0.65
const WORDS_PER_CREDIT = 150

// Returns the warning for an episode too cheap to be the whole article, or null
// when it isn't, or when credits or length are unknown. AWC's reported length
// wins over word_count on paywalled posts, where word_count is the preview, so
// this takes the larger of the two.
export function coverageWarning(run: { credits: number | null; reportedWords: number | null; wordCount: number | null }): string | null {
  const words = Math.max(run.reportedWords ?? 0, run.wordCount ?? 0)
  if (run.credits == null || words === 0) return null
  if (run.credits >= MIN_COVERAGE * (words / WORDS_PER_CREDIT)) return null
  return `short episode: ${run.credits} credits for about ${words.toLocaleString('en-US')} words`
}

const FENCED_JSON = /`{3}(?:json)?\s*(\{[\s\S]*?\})\s*`{3}/g

// Without structured_output, take the last fenced JSON block, else the
// outermost {...} span of the text.
function jsonFromText(text: string): RawResult | null {
  const fenced = [...text.matchAll(FENCED_JSON)].pop()?.[1]
  const start = text.indexOf('{')
  const candidate = fenced ?? (start === -1 ? '' : text.slice(start, text.lastIndexOf('}') + 1))
  if (!candidate) return null
  try {
    return JSON.parse(candidate) as RawResult
  } catch {
    return null
  }
}

function toAgentResult(raw: RawResult): AgentResult {
  const path = raw.path === 'url' || raw.path === 'script' ? raw.path : null
  if (raw.outcome === 'generating') {
    if (!path) return { outcome: 'failed', path: null, error: 'agent result missing path' }
    if (typeof raw.episode_title !== 'string' || !raw.episode_title.trim()) {
      return { outcome: 'failed', path: null, error: 'agent result missing episode_title' }
    }
    return {
      outcome: 'generating',
      path,
      episodeTitle: raw.episode_title.trim(),
      credits: typeof raw.credits === 'number' ? raw.credits : null,
      ...(typeof raw.reported_words === 'number' && raw.reported_words > 0 ? { reportedWords: raw.reported_words } : {}),
    }
  }
  if (raw.outcome === 'failed') {
    const error = typeof raw.error === 'string' ? boundError(raw.error) : ''
    return { outcome: 'failed', path, error: error || 'agent reported failure' }
  }
  return { outcome: 'failed', path: null, error: 'agent result has no outcome' }
}

export function parseClaudeResult(streamJson: string): AgentResult {
  let resultEvent: Record<string, unknown> | null = null
  for (const line of streamJson.split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as Record<string, unknown>
      if (event.type === 'result') resultEvent = event
    } catch {
      // Non-JSON noise on stdout.
    }
  }
  if (!resultEvent) return { outcome: 'failed', path: null, error: 'agent produced no result' }
  if (resultEvent.subtype !== 'success') {
    return { outcome: 'failed', path: null, error: `agent ended: ${String(resultEvent.subtype)}` }
  }
  if (resultEvent.structured_output && typeof resultEvent.structured_output === 'object') {
    return toAgentResult(resultEvent.structured_output as RawResult)
  }
  const fromText = typeof resultEvent.result === 'string' ? jsonFromText(resultEvent.result) : null
  return fromText ? toAgentResult(fromText) : { outcome: 'failed', path: null, error: 'agent produced no result' }
}
