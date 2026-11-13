"use client"

// /everything (#377): the whole active feed, with today's search and filters,
// sorted Newest (default) or Oldest. Items currently on home carry a PICK
// pill, computed with the same buildShortlist home uses. Tapping a card pins
// it to the top of home.

import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { type QueueItem, type SortDirection, sortByPublished } from "@/lib/queue-client"
import { ReadingList } from "@/components/reading-list"
import { useFeedQueue } from "@/lib/use-feed-queue"
import { useQueueFilters } from "@/lib/use-queue-filters"
import { buildShortlist, isNewSince, type Curation } from "@/lib/shortlist"

type PileSort = 'newest' | 'oldest'

interface EverythingClientProps {
  initialItems: QueueItem[]
  initialCuration: Curation | null
  serverNow: number
  // The previous visit (ISO), shared across devices; null before the first.
  newSince: string | null
}

export function EverythingClient({ initialItems, initialCuration, serverNow, newSince }: EverythingClientProps) {
  const { items, curation, nowMs, error, loadQueue, awcAgent, actions } =
    useFeedQueue({ items: initialItems, curation: initialCuration, nowMs: serverNow })
  const [sort, setSort] = useState<PileSort>('newest')
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)

  const pickIds = useMemo(
    () => new Set(buildShortlist(items, curation, nowMs).map(entry => entry.item.id)),
    [items, curation, nowMs],
  )
  const sorted = useMemo(() => sortByPublished(items, sort), [items, sort])
  // Fixed for this visit: newSince comes from the server render.
  const newIds = useMemo(
    () => new Set(items.filter(item => isNewSince(item, newSince)).map(item => item.id)),
    [items, newSince],
  )

  // Record this visit (as of the server render, so nothing added while the
  // page loaded is skipped). Best-effort: a failure only means the same items
  // read as NEW again next time.
  useEffect(() => {
    fetch('/api/settings/everything-seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seenAt: new Date(serverNow).toISOString() }),
    }).catch(err => console.warn('[Everything] Could not record the visit:', err))
  }, [serverNow])

  const {
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
  } = useQueueFilters(sorted, 'feed')

  const handleSortChange = useCallback((direction: SortDirection) => {
    if (direction === 'newest' || direction === 'oldest') setSort(direction)
  }, [])

  const { onPin, onNotNow } = actions
  const handleMakeNext = useCallback(async (item: QueueItem) => {
    if (await onPin(item)) toast.success("Pinned to the top of your picks")
  }, [onPin])
  // Offered on cards that are on home, e.g. to undo a mistaken Make next.
  const handleNotNow = useCallback(async (item: QueueItem) => {
    if (await onNotNow(item)) toast.success("Off your picks for 3 weeks")
  }, [onNotNow])

  const handleRefresh = useCallback(() => { loadQueue() }, [loadQueue])

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="text-center">
          <p className="text-destructive text-lg font-medium">{error}</p>
          <button onClick={() => loadQueue()} className="mt-4 rounded-lg bg-primary px-6 py-2 text-primary-foreground">
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <main className="min-h-screen bg-background">
      <ReadingList
        view="pile"
        items={filteredQueue}
        pickIds={pickIds}
        newIds={newIds}
        onNotNow={handleNotNow}
        onMarkComplete={actions.onMarkComplete}
        onSkip={actions.onSkip}
        onToggleStarted={actions.onToggleStarted}
        onStartItem={actions.onStartItem}
        onMakeNext={handleMakeNext}
        onListen={actions.onListen}
        onConvert={actions.onConvert}
        onConvertManually={actions.onConvertManually}
        awcAgent={awcAgent}
        onRefresh={handleRefresh}
        sortDirection={sort}
        onSortChange={handleSortChange}
        mediaFilter={mediaFilter}
        onMediaFilterChange={setMediaFilter}
        mediaCounts={mediaCounts}
        authorOptions={authorOptions}
        selectedAuthors={selectedAuthors}
        onSelectedAuthorsChange={setSelectedAuthors}
        readStateOptions={readStateOptions}
        selectedReadStates={selectedReadStates}
        onSelectedReadStatesChange={setSelectedReadStates}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        isAddDialogOpen={isAddDialogOpen}
        onAddDialogOpenChange={setIsAddDialogOpen}
        onEntryAdded={handleRefresh}
      />
    </main>
  )
}
