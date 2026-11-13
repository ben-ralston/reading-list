// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { buildHistory, toCandidate, type HistoryRow, type ItemRow } from './digest'

const row = (over: Partial<ItemRow> = {}): ItemRow => ({
  id: 1, title: 'A post', author: 'Zvi', status: '', progress: null,
  published_on: '2026-11-01', created_at: '2026-11-02T10:00:00+00:00',
  status_changed_at: null, added_by: null, duration_seconds: null,
  word_count: null, summary: null, sources: [], ...over,
})

describe('toCandidate', () => {
  it('derives minutes from duration, then word count, else null', () => {
    expect(toCandidate(row({ duration_seconds: 7800 })).minutes).toBe(130)
    expect(toCandidate(row({ word_count: 2300 })).minutes).toBe(10)
    expect(toCandidate(row({ word_count: 40 })).minutes).toBe(1)
    expect(toCandidate(row()).minutes).toBeNull()
  })

  it('counts article audio but not an Askwho comments episode', () => {
    expect(toCandidate(row({ sources: [{ platform: 'Spotify', source_label: 'Dwarkesh' }] })).hasAudio).toBe(true)
    expect(toCandidate(row({ sources: [{ platform: 'Askwho Casts', source_label: 'Comments' }, { platform: 'RSS', source_label: null }] })).hasAudio).toBe(false)
  })

  it('normalizes sparse rows', () => {
    const c = toCandidate(row({ author: null, summary: '', progress: '34%', status_changed_at: '2026-03-04T01:02:03+00:00' }))
    expect(c.author).toBe('')
    expect(c.summary).toBeNull()
    expect(c.progressPct).toBe(34)
    expect(c.addedOn).toBe('2026-11-02')
    expect(c.publishedOn).toBe('2026-11-01')
    expect(c.statusChangedOn).toBe('2026-03-04')
    expect(toCandidate(row({ progress: 'some' })).progressPct).toBeNull()
  })

  it('lists distinct non-empty source labels', () => {
    const c = toCandidate(row({ sources: [
      { platform: 'Spotify', source_label: 'Show' }, { platform: 'Spotify', source_label: 'Show' },
      { platform: 'RSS', source_label: null }, { platform: 'Podcast', source_label: ' ' },
    ] }))
    expect(c.labels).toEqual(['Show'])
  })
})

describe('buildHistory', () => {
  const now = Date.parse('2026-11-09T00:00:00Z')
  const day = 86_400_000
  const h = (author: string | null, status: 'Completed' | 'Skip', daysAgo: number | null, title = 't'): HistoryRow => ({
    title, author, status, status_changed_at: daysAgo === null ? null : new Date(now - daysAgo * day).toISOString(),
  })

  it('counts per author overall and in the last 90 days', () => {
    const history = buildHistory([
      h('Zvi', 'Completed', 1), h('Zvi', 'Completed', 10), h('Zvi', 'Completed', 120), h('Zvi', 'Skip', 5),
      h('Other', 'Skip', 2), h(null, 'Completed', 3), h('Zvi', 'Completed', null),
    ], now)
    expect(history.authors[0]).toEqual({ author: 'Zvi', completed: 4, skipped: 1, completed90d: 2, skipped90d: 1 })
    expect(history.authors.map(a => a.author)).toEqual(['Zvi', 'Other'])
  })

  it('caps authors at 80 and recent lists at 60 and 40, newest first', () => {
    const rows: HistoryRow[] = []
    for (let i = 0; i < 100; i++) rows.push(h(`a${i}`, 'Completed', i + 1, `c${i}`), h(`a${i}`, 'Skip', i + 1, `s${i}`))
    rows.push(h('undated', 'Completed', null, 'undated'))
    const history = buildHistory(rows, now)
    expect(history.authors).toHaveLength(80)
    expect(history.recentCompleted).toHaveLength(60)
    expect(history.recentSkipped).toHaveLength(40)
    expect(history.recentCompleted[0]).toEqual({ title: 'c0', author: 'a0' })
    expect(history.recentCompleted.some(r => r.title === 'undated')).toBe(false)
  })
})
