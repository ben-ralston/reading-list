// Structured AI summary (#304), shared by the generator (lib/summary.ts, server)
// and the queue UI (client). Pure: never import lib/supabase here.

export type SourceAccess = 'full_text' | 'descriptions_only'

// Shape the model returns (structured output) and the core of what we store.
export interface SummaryOutput {
  one_liner: string
  bullets: string[]
  source_access: SourceAccess
}

// Stored in content_items.summary_data (snake_case, like the rest of the DB).
export interface SummaryDataDB extends SummaryOutput {
  model: string
  version: 2
}

// App-side (camelCase) shape carried on QueueItem.summaryData.
export interface SummaryData {
  oneLiner: string
  bullets: string[]
  sourceAccess: SourceAccess
  model: string
}

export const NO_ACCESS_PREFIX = "Couldn't access the content"

export const SUMMARY_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['one_liner', 'bullets', 'source_access'],
  properties: {
    one_liner: { type: 'string' },
    bullets: { type: 'array', items: { type: 'string' } },
    source_access: { type: 'string', enum: ['full_text', 'descriptions_only'] },
  },
} as const

function validateOutput(raw: unknown): SummaryOutput | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const oneLiner = typeof r.one_liner === 'string' ? r.one_liner.trim() : ''
  if (!oneLiner) return null
  if (!Array.isArray(r.bullets) || !r.bullets.every((b) => typeof b === 'string')) return null
  const bullets = (r.bullets as string[]).map((b) => b.trim()).filter(Boolean)
  if (bullets.length > 6) return null
  if (bullets.length === 0 && !oneLiner.startsWith(NO_ACCESS_PREFIX)) return null
  if (r.source_access !== 'full_text' && r.source_access !== 'descriptions_only') return null
  return { one_liner: oneLiner, bullets, source_access: r.source_access }
}

export function parseSummaryOutput(text: string): SummaryOutput {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
  let raw: unknown
  try {
    raw = JSON.parse(cleaned)
  } catch {
    throw new Error('Summary output was not valid JSON')
  }
  const out = validateOutput(raw)
  if (!out) throw new Error('Summary output failed validation')
  return out
}

// Null for anything that isn't a valid v2 row, so the UI falls back to the
// legacy text summary instead of crashing on a malformed or future shape.
export function summaryDataFromDb(raw: unknown): SummaryData | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.version !== 2) return null
  const out = validateOutput(r)
  if (!out) return null
  return {
    oneLiner: out.one_liner,
    bullets: out.bullets,
    sourceAccess: out.source_access,
    model: typeof r.model === 'string' ? r.model : '',
  }
}

const DAY_MS = 86_400_000

// Back-catalog = published long before it entered the queue (e.g. following a
// podcast pulls its whole archive into Spotify saved episodes, #305). Ingest
// skips auto-summaries for these; manual Generate still works.
export function isBackCatalog(
  publishedOn: string | null | undefined,
  createdAt: string,
  maxAgeDays = 90,
): boolean {
  if (!publishedOn) return false
  const published = Date.parse(publishedOn)
  const created = Date.parse(createdAt)
  if (Number.isNaN(published) || Number.isNaN(created)) return false
  return created - published > maxAgeDays * DAY_MS
}
