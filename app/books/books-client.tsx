"use client"

// /books client — mirrors HomeClient (app/home-client.tsx) but scoped to
// kind='book'. Reuses the same optimistic-update helpers and ReadingList
// component; passes `kind='book'` to every queue-client call so the
// requests target /api/books instead of /api/queue.
//
// What's intentionally different from HomeClient:
// - No Spotify auto-sync / visibility / interval machinery — books don't
//   sync from Spotify. (Audible sync will land in its own ticket.)
// - The Add button opens an AddBookDialog instead of AddEntryDialog.

import { useCallback, useEffect, useRef, useState } from "react"
import {
  type QueueItem,
  type QueueItemUpdate,
  type SortDirection,
  fetchQueueData,
  updateItemStatus,
  batchUpdateQueue,
  makeItemNext,
  parseQueueData,
  isSortDirection,
} from "@/lib/queue-client"
import {
  applyComplete,
  applyToggleStarted,
  applyStartItem,
  applyMakeNext,
  applyReorder,
} from "@/lib/queue-mutations"
import { useQueueFilters } from "@/lib/use-queue-filters"
import { ReadingList } from "@/components/reading-list"
import { AddBookDialog } from "@/components/add-book-dialog"
import { toast } from "sonner"

const SORT_DIRECTION_KEY = 'books-sort-direction'

interface BooksClientProps {
  initialQueue: QueueItem[]
}

export function BooksClient({ initialQueue }: BooksClientProps) {
  const [queue, setQueue] = useState<QueueItem[]>(initialQueue)
  const [error, setError] = useState<string | null>(null)
  const [sortDirection, setSortDirection] = useState<SortDirection>('queue')
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)

  const actionLock = useRef(new Set<string>())
  const sortDirectionRef = useRef<SortDirection>(sortDirection)
  // Mirror the queue so handleReorder can read the current/top item (queue[0])
  // from inside its persist closure without re-creating the callback.
  const queueRef = useRef<QueueItem[]>(queue)

  // Load persisted sort direction post-mount to avoid SSR/CSR mismatch
  // (same approach as HomeClient).
  useEffect(() => {
    const saved = localStorage.getItem(SORT_DIRECTION_KEY)
    if (isSortDirection(saved)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- SSR-safe localStorage read; see comment above
      setSortDirection(saved)
      setQueue((current) => parseQueueData([...current], saved))
    }
  }, [])

  useEffect(() => {
    sortDirectionRef.current = sortDirection
  }, [sortDirection])

  useEffect(() => {
    queueRef.current = queue
  }, [queue])

  const loadQueue = useCallback(async (direction?: SortDirection) => {
    const sortDir = direction ?? sortDirectionRef.current
    try {
      const data = await fetchQueueData('book')
      setQueue(parseQueueData([...data], sortDir))
      setError(null)
    } catch (err) {
      setError("Failed to load books. Please check your connection.")
      toast.error("Failed to load books. Please check your connection.")
      console.error(err)
    }
  }, [])

  const handleSortChange = useCallback((newDirection: SortDirection) => {
    setSortDirection(newDirection)
    localStorage.setItem(SORT_DIRECTION_KEY, newDirection)
    setQueue((current) => parseQueueData([...current], newDirection))
  }, [])

  const handleRefresh = useCallback(() => {
    loadQueue(sortDirectionRef.current)
  }, [loadQueue])

  // Books mostly arrive without queue_position — the Goodreads importer
  // intentionally skips ranking ("to-read" library shouldn't crowd the
  // feed queue's heuristics). Unlike HomeClient, which hides unpositioned
  // feed items (treated as soft-skipped suggestions), the books view shows
  // every active row so the imported library is actually visible.
  const queuedItems = queue

  // Media + author + read-state filtering (AND-composed) and dropdown
  // options (#202, #227) — same shared hook as HomeClient; 'book' selects
  // the In progress / Not started state set.
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
  } = useQueueFilters(queuedItems, 'book')

  const acquireLock = useCallback((lockKey: string): boolean => {
    if (actionLock.current.has(lockKey)) {
      toast.info("Please wait — previous action still in progress")
      return false
    }
    if (lockKey !== 'queue-reorder' && actionLock.current.has('queue-reorder')) {
      toast.info("Please wait — queue reorder in progress")
      return false
    }
    if (lockKey === 'queue-reorder' && Array.from(actionLock.current).some((k) => k.startsWith('item-'))) {
      toast.info("Please wait — item action in progress")
      return false
    }
    actionLock.current.add(lockKey)
    return true
  }, [])

  // Same shape as HomeClient.runOptimisticAction — kept local so it can hit
  // the books endpoints via the kind='book' arg on each queue-client call.
  const runOptimisticAction = useCallback(
    async (
      lockKey: string,
      actionName: string,
      transform: (queue: QueueItem[]) => QueueItem[],
      apiCall: () => Promise<void>,
    ) => {
      if (!acquireLock(lockKey)) return
      let previousQueue: QueueItem[] = []
      setQueue((current) => {
        previousQueue = current
        return parseQueueData(transform(current), sortDirectionRef.current)
      })
      try {
        await apiCall()
      } catch (err) {
        const message = err instanceof Error ? err.message : `Failed to ${actionName}`
        console.error(`Failed to ${actionName}:`, err)
        toast.error(message)
        setQueue(previousQueue)
      } finally {
        actionLock.current.delete(lockKey)
      }
    },
    [acquireLock],
  )

  const handleMarkComplete = useCallback(
    (item: QueueItem) =>
      runOptimisticAction(`item-${item.id}`, "mark complete",
        (q) => applyComplete(q, item.id),
        () => updateItemStatus(item.id, "Completed", 'book'),
      ),
    [runOptimisticAction],
  )

  const handleSkip = useCallback(
    (item: QueueItem) =>
      runOptimisticAction(`item-${item.id}`, "skip item",
        (q) => applyComplete(q, item.id),
        () => updateItemStatus(item.id, "Skip", 'book'),
      ),
    [runOptimisticAction],
  )

  const handleToggleStarted = useCallback(
    (item: QueueItem) => {
      const newStatus = item.status === "In Progress" ? "" : "In Progress"
      return runOptimisticAction(`item-${item.id}`, "update status",
        (q) => applyToggleStarted(q, item.id, item.status),
        () => updateItemStatus(item.id, newStatus, 'book'),
      )
    },
    [runOptimisticAction],
  )

  const handleStartItem = useCallback(
    (item: QueueItem) => {
      if (item.status === "In Progress") return Promise.resolve()
      return runOptimisticAction(`item-${item.id}`, "start item",
        (q) => applyStartItem(q, item.id),
        () => updateItemStatus(item.id, "In Progress", 'book'),
      )
    },
    [runOptimisticAction],
  )

  const handleMakeNext = useCallback(
    async (item: QueueItem) => {
      const lockKey = 'queue-reorder'
      if (!acquireLock(lockKey)) return
      let previousQueue: QueueItem[] = []
      let itemsToShift: QueueItem[] = []

      setQueue((current) => {
        previousQueue = current
        itemsToShift = current
          .filter((q) => q.queuePosition !== null && q.id !== item.id)
          .sort((a, b) => (a.queuePosition || 0) - (b.queuePosition || 0))
        // Confirm every positioned book (see handleReorder) so promoting one
        // doesn't leave the shifted books showing the pending UI.
        return parseQueueData(
          applyMakeNext(current, item.id).map((it) =>
            it.queuePosition !== null ? { ...it, positionConfirmed: true } : it,
          ),
          sortDirectionRef.current,
        )
      })

      try {
        // #229: position writes go through the atomic server-side placement —
        // a client-computed renumber batch from a stale snapshot mints
        // duplicate positions.
        await makeItemNext(item.id, 'book')
        // Books bulk-confirm every positioned book on promote (see the
        // optimistic transform above). Flag-only batch: no queuePosition
        // fields, so a stale snapshot can't corrupt positions.
        const confirmUpdates: QueueItemUpdate[] = itemsToShift
          .filter((q) => !q.positionConfirmed)
          .map((q) => ({ id: q.id, positionConfirmed: true }))
        if (confirmUpdates.length > 0) {
          await batchUpdateQueue(confirmUpdates, 'book')
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to promote book'
        console.error('Failed to promote book:', err)
        toast.error(message)
        setQueue(previousQueue)
      } finally {
        actionLock.current.delete(lockKey)
      }
    },
    [acquireLock],
  )



  const handleReorder = useCallback(
    (reorderedItems: QueueItem[], movedItemId: number) => {
      // The current/top book (queue[0]) isn't part of the dragged list but must
      // be pinned to position 1, else a freshly-imported library (all positions
      // null) leaves it null while the rest get 2..N — and on the next load it
      // sorts last (nulls-last), so the top book silently jumps to the bottom.
      // handleMakeNext already does the position-1 push; mirror it here.
      const currentItem = queueRef.current[0]
      return runOptimisticAction('queue-reorder', "reorder queue",
        // Books have no AI-suggested ranking (#147): a manual reorder is the
        // user explicitly ranking their list, so confirm every positioned book
        // and pin the current item to position 1. Confirming only the moved
        // item (the feed's behaviour) would leave the rest positioned-but-
        // unconfirmed → spurious pending UI.
        (q) => applyReorder(q, reorderedItems, movedItemId).map((it, idx) =>
          idx === 0
            ? { ...it, queuePosition: 1, positionConfirmed: true }
            : it.queuePosition !== null
              ? { ...it, positionConfirmed: true }
              : it,
        ),
        () => {
          const updates: QueueItemUpdate[] = reorderedItems.map((item, index) => ({
            id: item.id,
            queuePosition: index + 2,
            positionConfirmed: true,
          }))
          if (currentItem) {
            updates.push({ id: currentItem.id, queuePosition: 1, positionConfirmed: true })
          }
          return batchUpdateQueue(updates, 'book')
        },
      )
    },
    [runOptimisticAction],
  )

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="text-center">
          <p className="text-destructive text-lg font-medium">{error}</p>
          <button
            onClick={() => loadQueue()}
            className="mt-4 rounded-lg bg-primary px-6 py-2 text-primary-foreground"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <main className="min-h-screen bg-background">
      <ReadingList
        items={filteredQueue}
        onMarkComplete={handleMarkComplete}
        onSkip={handleSkip}
        onToggleStarted={handleToggleStarted}
        onStartItem={handleStartItem}
        onMakeNext={handleMakeNext}
        onReorder={handleReorder}
        onRefresh={handleRefresh}
        sortDirection={sortDirection}
        onSortChange={handleSortChange}
        mediaFilter={mediaFilter}
        onMediaFilterChange={setMediaFilter}
        authorOptions={authorOptions}
        selectedAuthors={selectedAuthors}
        onSelectedAuthorsChange={setSelectedAuthors}
        readStateOptions={readStateOptions}
        selectedReadStates={selectedReadStates}
        onSelectedReadStatesChange={setSelectedReadStates}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        mediaCounts={mediaCounts}
        isAddDialogOpen={isAddDialogOpen}
        onAddDialogOpenChange={setIsAddDialogOpen}
        kind="book"
      />
      <AddBookDialog
        open={isAddDialogOpen}
        onOpenChange={setIsAddDialogOpen}
        onAdded={handleRefresh}
      />
    </main>
  )
}
