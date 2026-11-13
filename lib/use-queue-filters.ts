// Shared queue-filter state for the feed and books clients (#202): the media
// filter that used to live copy-pasted in both, plus the author multi-select
// and the read-state multi-select (#227). Filters AND-compose; the author and
// read-state dropdowns are each scoped to the media-filtered items (not to
// each other), so neither dropdown's counts shift as the other is used
// (buildAuthorOptions unions in out-of-scope selections at count 0;
// buildReadStateOptions always lists the kind's full state set). No filter
// persists — all reset on reload by design (sort direction is the only
// persisted preference). The text search (#283) is applied first, so every
// count and option describes what is reachable under the current query; it
// is independent of the sheet's badge/chips.

import { useMemo, useState } from 'react'
import type { ContentKind, QueueItem } from './queue-client'
import { hasMediaType, type MediaFilter } from './media-type'
import { buildAuthorOptions, matchesAuthorFilter, type AuthorOption } from './author-filter'
import { buildReadStateOptions, matchesReadStateFilter, type ReadState, type ReadStateOption } from './read-state'
import { filterBySearch } from './search-filter'

export function useQueueFilters(queuedItems: QueueItem[], kind: ContentKind = 'feed'): {
  searchQuery: string
  setSearchQuery: (query: string) => void
  mediaFilter: MediaFilter
  setMediaFilter: (filter: MediaFilter) => void
  selectedAuthors: string[]
  setSelectedAuthors: (labels: string[]) => void
  selectedReadStates: ReadState[]
  setSelectedReadStates: (states: ReadState[]) => void
  filteredQueue: QueueItem[]
  mediaCounts: { all: number; audio: number; text: number }
  authorOptions: AuthorOption[]
  readStateOptions: ReadStateOption[]
} {
  const [searchQuery, setSearchQuery] = useState('')
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>('all')
  const [selectedAuthors, setSelectedAuthors] = useState<string[]>([])
  const [selectedReadStates, setSelectedReadStates] = useState<ReadState[]>([])

  const searched = useMemo(() => filterBySearch(queuedItems, searchQuery), [queuedItems, searchQuery])

  const mediaFiltered = useMemo(() => {
    return mediaFilter === 'all'
      ? searched
      : searched.filter(item => hasMediaType(item, mediaFilter))
  }, [searched, mediaFilter])

  const readStateFiltered = useMemo(() => {
    return selectedReadStates.length === 0
      ? mediaFiltered
      : mediaFiltered.filter(item => matchesReadStateFilter(item, kind, selectedReadStates))
  }, [mediaFiltered, kind, selectedReadStates])

  const filteredQueue = useMemo(() => {
    return selectedAuthors.length === 0
      ? readStateFiltered
      : readStateFiltered.filter(item => matchesAuthorFilter(item, selectedAuthors))
  }, [readStateFiltered, selectedAuthors])

  // Pill counts are deliberately computed over the whole (searched) queue,
  // not the media/author/read-state subset, so they always describe what
  // each pill would show under the current query.
  const mediaCounts = useMemo(() => ({
    all: searched.length,
    audio: searched.filter(item => hasMediaType(item, 'audio')).length,
    text: searched.filter(item => hasMediaType(item, 'text')).length,
  }), [searched])

  const authorOptions = useMemo(
    () => buildAuthorOptions(mediaFiltered, selectedAuthors),
    [mediaFiltered, selectedAuthors],
  )

  const readStateOptions = useMemo(
    () => buildReadStateOptions(mediaFiltered, kind),
    [mediaFiltered, kind],
  )

  return {
    searchQuery,
    setSearchQuery,
    mediaFilter,
    setMediaFilter,
    selectedAuthors,
    setSelectedAuthors,
    selectedReadStates,
    setSelectedReadStates,
    filteredQueue,
    mediaCounts,
    authorOptions,
    readStateOptions,
  }
}
