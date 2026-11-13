// Attaches author engagement scores (#255) to queue items, powering the
// client-side "Recommended" sort. Reads the author_engagement_scores view in
// one small query and matches items in TS — same approach as
// lib/scoring/engagement.ts getAuthorScore, but batched for a whole queue.
//
// View semantics (see migration 20260208000000): the score is
// (completed − skipped) / total per canonical author, where `total` counts
// ALL of that author's items including ones still sitting in the queue, and
// the view only lists authors with total >= 3. So a large unread backlog
// deflates an author's score toward 0 — the signal is a floor on demonstrated
// interest, not a completion rate over decided items.

import type { SupabaseClient } from '@supabase/supabase-js'
import { authorKey } from '@/lib/author-filter'
import type { QueueItem } from '@/lib/queue-client'

export interface EngagementRow {
  canonical_author: string
  aliases: string[]
  // PostgREST can serialize numerics as strings; always Number()-coerce.
  engagement_score: number | string
}

// Fail-open: the queue must never 500 (or lose its SSR paint) because the
// scoring view is unavailable — items just read as neutral downstream.
export async function fetchEngagementRows(supabase: SupabaseClient): Promise<EngagementRow[]> {
  const { data, error } = await supabase
    .from('author_engagement_scores')
    .select('canonical_author, aliases, engagement_score')

  if (error) {
    console.error('[Engagement] Error fetching author engagement scores:', error)
    return []
  }
  return (data as EngagementRow[]) ?? []
}

// Pure: returns new item objects with engagementScore set (number or null).
// Keys are normalized through authorKey so casing/whitespace variants match.
// The '' key (empty or literal-"Unknown" authors) is deliberately skipped —
// junk-authored items must read neutral, not inherit an aggregated bucket.
export function attachEngagementScores(items: QueueItem[], rows: EngagementRow[]): QueueItem[] {
  const scoreByKey = new Map<string, number>()
  for (const row of rows) {
    const score = Number(row.engagement_score)
    if (Number.isNaN(score)) continue
    for (const name of [row.canonical_author, ...(row.aliases ?? [])]) {
      const key = authorKey(name)
      if (key !== '') scoreByKey.set(key, score)
    }
  }

  return items.map(item => ({
    ...item,
    engagementScore: scoreByKey.get(authorKey(item.author)) ?? null,
  }))
}
