// Number of active filter-sheet filters (#241): media counts as one, each
// selected status and author as one. The single definition behind the funnel
// badge, the summary chips, and ReadingList's empty-state branching. Pure —
// state lives in lib/use-queue-filters.ts. The text search is deliberately
// excluded (#283): it has its own field and clear affordance.

import type { MediaFilter } from './media-type'
import type { ReadState } from './read-state'

export function activeSheetFilterCount(
  mediaFilter: MediaFilter,
  selectedReadStates: ReadState[],
  selectedAuthors: string[],
): number {
  return (mediaFilter !== 'all' ? 1 : 0) + selectedReadStates.length + selectedAuthors.length
}
