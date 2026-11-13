// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { workspaceFiles } from './workspace'
import { toCandidate, type HistoryRow, type ItemRow } from './digest'

const row: ItemRow = {
  id: 5, title: 'A "quoted"\ntitle', author: 'Zvi', status: 'In Progress', progress: '40%',
  published_on: '2026-11-01', created_at: '2026-11-02T00:00:00Z', status_changed_at: null, added_by: null,
  duration_seconds: 600, word_count: null, summary: 'One line.',
  summary_data: { version: 2, one_liner: 'One line.', bullets: ['First point', 'Second point', 7] },
  sources: [
    { platform: 'Substack', source_label: null, link: 'https://example.com/post' },
    { platform: 'Spotify', source_label: 'Show', link: 'https://open.spotify.com/episode/x' },
    { platform: 'Podcast', source_label: null, link: null },
  ],
}
const history: HistoryRow[] = [
  { title: 'Done', author: 'Zvi', status: 'Completed', status_changed_at: '2026-10-01T05:00:00Z' },
  { title: 'Nope', author: null, status: 'Skip', status_changed_at: null },
]

describe('toCandidate (agent fields)', () => {
  it('carries links and summary bullets', () => {
    const c = toCandidate(row)
    expect(c.links).toEqual(['https://example.com/post', 'https://open.spotify.com/episode/x'])  // sorted
    expect(c.bullets).toEqual(['First point', 'Second point'])
    expect(toCandidate({ ...row, summary_data: null, sources: [] })).toMatchObject({ links: [], bullets: [] })
    expect(toCandidate({ ...row, summary_data: 'legacy text' }).bullets).toEqual([])
  })
})

describe('toCandidate (stable order)', () => {
  it('gives the same labels and links whatever order the sources arrive in', () => {
    const sources = [
      { platform: 'Spotify', source_label: 'Zeta Show', link: 'https://z.example/1' },
      { platform: 'Substack', source_label: 'Alpha Letter', link: 'https://a.example/1' },
    ]
    const forward = toCandidate({ ...row, sources })
    const reversed = toCandidate({ ...row, sources: [...sources].reverse() })
    expect(reversed.labels).toEqual(forward.labels)
    expect(reversed.links).toEqual(forward.links)
    expect(forward.labels).toEqual(['Alpha Letter', 'Zeta Show'])
  })
})

describe('workspaceFiles', () => {
  const files = workspaceFiles({ candidates: [toCandidate(row)], historyRows: history, memory: 'likes AI control\n', instructions: 'I mostly listen.' })

  it('writes one JSON object per line for the queue', () => {
    const lines = files['queue.jsonl'].trimEnd().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({
      id: 5, title: 'A "quoted"\ntitle', author: 'Zvi', status: 'In Progress', progressPct: 40,
      minutes: 10, hasAudio: true, links: ['https://example.com/post', 'https://open.spotify.com/episode/x'],
      bullets: ['First point', 'Second point'],
    })
  })

  it('writes the full history with plain outcome words', () => {
    const lines = files['history.jsonl'].trimEnd().split('\n').map((l) => JSON.parse(l))
    expect(lines).toEqual([
      { title: 'Done', author: 'Zvi', outcome: 'finished', date: '2026-10-01' },
      { title: 'Nope', author: '', outcome: 'skipped', date: null },
    ])
  })

  it('includes memory and instructions and nothing else', () => {
    expect(files['memory.md']).toBe('likes AI control\n')
    expect(files['instructions.md']).toBe('I mostly listen.')
    expect(Object.keys(files).sort()).toEqual(['history.jsonl', 'instructions.md', 'memory.md', 'queue.jsonl'])
  })
})
