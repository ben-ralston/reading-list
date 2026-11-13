// Read-state filter logic for the queue pages (#227). Pure functions — the
// Status dropdown UI lives in components/reading-list.tsx and the state
// wiring in lib/use-queue-filters.ts.
//
// Unlike the author filter, the vocabulary is a closed enum, so the options
// builder always returns the full fixed per-kind list (zero counts included)
// and selection state stores keys. Feed items split pending into confirmed
// vs AI-suggested via positionConfirmed; books never surface that
// distinction, so their pending bucket is a single "Not started".

import { AWAITING_COMMENTS } from './content-status'
import type { ContentKind, QueueItem } from './queue-client'

export type ReadState = 'awaiting-comments' | 'in-progress' | 'confirmed' | 'suggested' | 'not-started'

export interface ReadStateOption {
  key: ReadState
  label: string
  count: number
}

export const READ_STATE_LABELS: Record<ReadState, string> = {
  'in-progress': 'In progress',
  'awaiting-comments': 'Awaiting comments',
  confirmed: 'Confirmed',
  suggested: 'Suggested',
  'not-started': 'Not started',
}

export const READ_STATES_BY_KIND: Record<ContentKind, ReadState[]> = {
  feed: ['in-progress', 'awaiting-comments', 'confirmed', 'suggested'],
  book: ['in-progress', 'not-started'],
}

// The started check must come first: an in-progress item with an unconfirmed
// position is in-progress, not suggested.
export function readStateOf(item: QueueItem, kind: ContentKind): ReadState {
  if (kind === 'feed' && item.status === AWAITING_COMMENTS) return 'awaiting-comments'
  if (item.status === 'In Progress') return 'in-progress'
  if (kind === 'book') return 'not-started'
  return item.positionConfirmed ? 'confirmed' : 'suggested'
}

// Options for the Status dropdown: the kind's full state list with counts
// over `scopedItems` (the media-filtered queue). Zero-count states stay
// listed, so active selections are always visible and clearable.
export function buildReadStateOptions(
  scopedItems: QueueItem[],
  kind: ContentKind,
): ReadStateOption[] {
  const counts = new Map<ReadState, number>()
  for (const item of scopedItems) {
    const state = readStateOf(item, kind)
    counts.set(state, (counts.get(state) ?? 0) + 1)
  }
  return READ_STATES_BY_KIND[kind].map(key => ({
    key,
    label: READ_STATE_LABELS[key],
    count: counts.get(key) ?? 0,
  }))
}

// True when the item passes the read-state filter (empty selection = no
// filter; multiple selections OR together).
export function matchesReadStateFilter(
  item: QueueItem,
  kind: ContentKind,
  selected: ReadState[],
): boolean {
  if (selected.length === 0) return true
  return selected.includes(readStateOf(item, kind))
}
