// Author-filter logic for the queue pages (#202). Pure functions — the
// dropdown UI lives in components/reading-list.tsx and the state wiring in
// lib/use-queue-filters.ts.
//
// Authors are matched by a normalized key (trimmed, lowercased) so casing and
// stray whitespace variants of the same name act as one author. Selection
// state stores display labels (not keys) because an out-of-scope selected
// author may have no in-scope item to recover its casing from.

import type { QueueItem } from './queue-client'

// Items with an empty/whitespace-only author are bucketed under this label.
// Author strings that themselves normalize to "unknown" (parsers write the
// literal "Unknown" when they can't determine an author — observed in prod)
// merge into the same bucket, so selecting it matches them too.
export const UNKNOWN_AUTHOR_LABEL = 'Unknown'

export interface AuthorOption {
  key: string
  label: string
  count: number
}

// Normalized identity for an author string; '' is the Unknown bucket.
export function authorKey(author: string): string {
  const key = author.trim().toLowerCase()
  return key === 'unknown' ? '' : key
}

// Key for a selection label: the Unknown label stands for the empty key.
function selectionKey(label: string): string {
  return label === UNKNOWN_AUTHOR_LABEL ? '' : authorKey(label)
}

// Options for the Authors dropdown: distinct authors of `scopedItems` (the
// media-filtered queue) with in-scope counts, unioned with any selected
// authors that fall outside the scope (count 0) so active selections are
// always visible and clearable. Sorted alphabetically, Unknown pinned last.
export function buildAuthorOptions(
  scopedItems: QueueItem[],
  selectedAuthors: string[],
): AuthorOption[] {
  const byKey = new Map<string, AuthorOption>()

  // Selected labels first so their casing wins over scope's first-seen casing
  // (checked state matches on label; it must not detach when scope changes).
  for (const label of selectedAuthors) {
    const key = selectionKey(label)
    byKey.set(key, { key, label: key === '' ? UNKNOWN_AUTHOR_LABEL : label, count: 0 })
  }

  for (const item of scopedItems) {
    const key = authorKey(item.author)
    const existing = byKey.get(key)
    if (existing) {
      existing.count++
    } else {
      const label = key === '' ? UNKNOWN_AUTHOR_LABEL : item.author.trim()
      byKey.set(key, { key, label, count: 1 })
    }
  }

  return [...byKey.values()].sort((a, b) => {
    if (a.key === '') return 1
    if (b.key === '') return -1
    return a.label.toLowerCase().localeCompare(b.label.toLowerCase())
  })
}

// True when the item passes the author filter (empty selection = no filter).
export function matchesAuthorFilter(item: QueueItem, selectedAuthors: string[]): boolean {
  if (selectedAuthors.length === 0) return true
  const key = authorKey(item.author)
  return selectedAuthors.some(label => selectionKey(label) === key)
}
