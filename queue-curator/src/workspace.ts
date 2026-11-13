// The tool-enabled agent's working folder: the whole queue and the full
// history as files it can read and search, plus its own notes and the owner's
// instructions. Pure: returns file contents, main.ts writes them.
import type { Candidate, HistoryRow } from './digest'

export function workspaceFiles(input: {
  candidates: Candidate[]
  historyRows: HistoryRow[]
  memory: string
  instructions: string
}): Record<string, string> {
  const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
  return {
    'queue.jsonl': jsonl(input.candidates),
    'history.jsonl': jsonl(
      input.historyRows.map((row) => ({
        title: row.title,
        author: row.author?.trim() ?? '',
        outcome: row.status === 'Completed' ? 'finished' : 'skipped',
        date: row.status_changed_at ? row.status_changed_at.slice(0, 10) : null,
      })),
    ),
    'memory.md': input.memory,
    'instructions.md': input.instructions,
  }
}
