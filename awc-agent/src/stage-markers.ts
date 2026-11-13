// Live stream-json watcher for the awc-agent Claude session (#317).
//
// Stages: the agent has no shell or file tools, so it reports progress by
// writing a line `AWC_STAGE: <stage>` in its own text output. Only assistant
// TEXT blocks count — tool results (web page content) can't fake a stage —
// and a marker must start its line; only whitelisted stages are forwarded.
//
// The same pass surfaces the agent's tool calls (for the daemon's navigation
// guard) and the final `result` event, so the caller never has to hold the
// whole — screenshot-heavy — stream in memory.
import { isAgentStage, type AgentStage } from '../../lib/awc/stages'

const MARKER = /^[ \t]*AWC_STAGE:[ \t]*(.+?)[ \t]*$/gm

export function extractStageMarkers(text: string): { stages: AgentStage[]; rejected: string[] } {
  const stages: AgentStage[] = []
  const rejected: string[] = []
  for (const match of text.matchAll(MARKER)) {
    const value = match[1]
    if (isAgentStage(value)) stages.push(value)
    else rejected.push(value.slice(0, 80))
  }
  return { stages, rejected }
}

interface StreamEvent {
  type?: string
  message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }> }
}

export function createStageParser(deps: {
  onStage: (stage: AgentStage) => void
  onRejected: (value: string) => void
  onToolUse?: (name: string, input: Record<string, unknown>) => void
  onResultLine?: (line: string) => void
}) {
  let pending = ''

  const handleLine = (line: string) => {
    if (!line.trim()) return
    let event: StreamEvent
    try {
      event = JSON.parse(line) as StreamEvent
    } catch {
      return
    }
    if (event.type === 'result') {
      deps.onResultLine?.(line)
      return
    }
    if (event.type !== 'assistant') return
    for (const block of event.message?.content ?? []) {
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        const input = block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {}
        deps.onToolUse?.(block.name, input)
        continue
      }
      if (block.type !== 'text' || typeof block.text !== 'string') continue
      const { stages, rejected } = extractStageMarkers(block.text)
      for (const stage of stages) deps.onStage(stage)
      for (const value of rejected) deps.onRejected(value)
    }
  }

  return {
    push(chunk: string) {
      const combined = pending + chunk
      const lines = combined.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) handleLine(line)
    },
    flush() {
      handleLine(pending)
      pending = ''
    },
  }
}
