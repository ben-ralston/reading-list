// Builds the curator's prompt from the template (prompt.md), the owner's standing
// instructions and the digest. Pure. Everything feed-controlled goes inside
// one fenced block with angle brackets escaped, so no title can close the
// fence; the real boundary is still "no tools + validated output".
import type { Candidate, History } from './digest'

// Bump when prompt.md or the data layout changes in a way that should force
// a fresh run (it is part of the input hash in later stages).
export const PROMPT_VERSION = 1
export const MAX_PICKS = 25
export const MAX_REASON_CHARS = 60

const MAX_SUMMARY_CHARS = 200
const FENCE = 'untrusted_queue_data'

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function candidateLine(c: Candidate): string {
  const state = c.status === ''
    ? 'not started'
    : `${c.status}${c.progressPct !== null ? ` ${c.progressPct}%` : ''}${c.statusChangedOn ? ` (status changed ~${c.statusChangedOn})` : ''}`
  const parts = [
    `id=${c.id}`,
    clean(c.title),
    `by ${clean(c.author) || 'unknown'}`,
    ...(c.labels.length ? [`show: ${c.labels.map(clean).join(', ')}`] : []),
    c.hasAudio ? 'audio' : 'text',
    c.minutes !== null ? `${c.minutes} min` : 'length unknown',
    state,
    `published ${c.publishedOn ?? 'unknown'}`,
    `added ${c.addedOn}`,
    ...(c.addedBy ? [`added by ${clean(c.addedBy)}`] : []),
    ...(c.summary ? [`summary: ${clean(c.summary.slice(0, MAX_SUMMARY_CHARS))}`] : []),
  ]
  return parts.join(' | ')
}

function dataBlock(candidates: Candidate[], history: History): string {
  const titled = (rows: { title: string; author: string }[]) =>
    rows.map((r) => `- ${clean(r.title)} (${clean(r.author) || 'unknown'})`)
  return [
    `<${FENCE}>`,
    `QUEUE (${candidates.length} items)`,
    ...candidates.map(candidateLine),
    '',
    'HISTORY BY AUTHOR OR SHOW',
    ...history.authors.map(
      (a) => `${clean(a.author)} | finished ${a.completed}, skipped ${a.skipped} | last 90 days: finished ${a.completed90d}, skipped ${a.skipped90d}`,
    ),
    '',
    'MOST RECENTLY FINISHED (newest first)',
    ...titled(history.recentCompleted),
    '',
    'MOST RECENTLY SKIPPED (newest first)',
    ...titled(history.recentSkipped),
    `</${FENCE}>`,
  ].join('\n')
}

export function buildPrompt(input: {
  template: string
  instructions: string
  candidates: Candidate[]
  history: History
  today: string
}): string {
  // Function replacers: a `$&` in the data must not be read as a pattern.
  return input.template
    .replace('{{TODAY}}', () => input.today)
    .replace('{{INSTRUCTIONS}}', () => input.instructions.trim())
    .replace('{{DATA}}', () => dataBlock(input.candidates, input.history))
}
