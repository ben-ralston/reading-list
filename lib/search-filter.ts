// Text search over the queue and archive lists (#283). Pure functions — the
// input UI lives in components/search-field.tsx; queue-page state wiring is
// in lib/use-queue-filters.ts and the archive keeps its own state in
// components/archive-list.tsx. Case-insensitive substring on title, then
// author. No fuzzy matching by design.

import type { QueueItem } from './queue-client'

export function normalizeSearchQuery(query: string): string {
  return query.trim().toLowerCase()
}

// The shared "nothing matched" line for both the queue and archive empty
// states. Trim-only: it echoes the user's casing, so deliberately not
// normalizeSearchQuery.
export function noSearchMatchesMessage(query: string): string {
  return `No items match "${query.trim()}"`
}

// True when the query would actually filter (non-blank after trimming). The
// single definition of "search is active" — UI copy and filtering share it.
export function hasSearchQuery(query: string): boolean {
  return normalizeSearchQuery(query) !== ''
}

// Filters `items` by the query, normalizing it once. Returns the SAME array
// when the query is blank so downstream memos keep their identity. Lives in
// lib (not the hook) because ArchiveList, which has no filter hook, uses it too.
export function filterBySearch<T extends Pick<QueueItem, 'title' | 'author'>>(items: T[], query: string): T[] {
  const needle = normalizeSearchQuery(query)
  if (needle === '') return items
  return items.filter(
    item => item.title.toLowerCase().includes(needle) || item.author.toLowerCase().includes(needle),
  )
}
