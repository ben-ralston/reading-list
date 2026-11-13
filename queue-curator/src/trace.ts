// What a tool-enabled run actually did, read from its stream-json output:
// how many calls of each tool, which pages it fetched, what it searched for.
// URLs and queries are model-chosen and influenced by feed text, so they are
// cleaned to one line before anyone prints them.
import { oneLine } from './text'

export interface ToolTrace {
  counts: Record<string, number>
  fetched: string[]
  searched: string[]
}

const MAX_DETAIL_CHARS = 120

// How the session itself said it ended ("claude ended: error_max_turns",
// "claude ended: success: Not logged in"), for failure messages. Null when
// the stream has no result event. The text is model- and CLI-written, so it
// is cleaned to one short line.
export function resultDetail(streamJson: string): string | null {
  let last: { subtype?: unknown; result?: unknown } | null = null
  for (const line of streamJson.split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (event && typeof event === 'object' && event.type === 'result') last = event
    } catch {
      // Non-JSON noise on stdout.
    }
  }
  if (!last) return null
  const text = typeof last.result === 'string' ? oneLine(last.result) : ''
  const detail = `claude ended: ${oneLine(String(last.subtype))}${text ? `: ${text}` : ''}`
  return detail.length > MAX_DETAIL_CHARS ? `${detail.slice(0, MAX_DETAIL_CHARS - 1)}…` : detail
}

export function toolTrace(streamJson: string): ToolTrace {
  const trace: ToolTrace = { counts: {}, fetched: [], searched: [] }
  for (const line of streamJson.split('\n')) {
    if (!line.trim()) continue
    let event: { type?: unknown; message?: { content?: unknown } }
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const content = event && event.type === 'assistant' ? event.message?.content : null
    if (!Array.isArray(content)) continue
    for (const block of content as { type?: unknown; name?: unknown; input?: { url?: unknown; query?: unknown } }[]) {
      if (!block || block.type !== 'tool_use' || typeof block.name !== 'string') continue
      trace.counts[block.name] = (trace.counts[block.name] ?? 0) + 1
      if (block.name === 'WebFetch' && typeof block.input?.url === 'string') trace.fetched.push(oneLine(block.input.url))
      if (block.name === 'WebSearch' && typeof block.input?.query === 'string') trace.searched.push(oneLine(block.input.query))
    }
  }
  return trace
}
