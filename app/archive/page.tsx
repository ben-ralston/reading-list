"use client"

import { useEffect, useState } from "react"
import { type QueueItem, fetchArchivedItems, restoreItem } from "@/lib/queue-client"
import { ArchiveList } from "@/components/archive-list"
import { Loader2 } from "lucide-react"

export default function ArchivePage() {
  const [items, setItems] = useState<QueueItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadArchive = async () => {
    try {
      const data = await fetchArchivedItems()
      setItems(data)
      setError(null)
    } catch (err) {
      setError("Failed to load archive. Please check your connection.")
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  // On-mount data fetch: setState happens after `await fetchArchivedItems()`, so
  // there is no cascading-render hazard, but the lint rule can't see across the
  // function boundary into the async body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch on mount; setState only after the network response resolves
    loadArchive()
  }, [])

  const handleRestore = async (item: QueueItem) => {
    try {
      await restoreItem(item.id)
      // Refresh the list after restoring
      await loadArchive()
    } catch (err) {
      console.error("Failed to restore item:", err)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="text-center">
          <p className="text-destructive text-lg font-medium">{error}</p>
          <button onClick={loadArchive} className="mt-4 rounded-lg bg-primary px-6 py-2 text-primary-foreground">
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <main className="min-h-screen bg-background">
      <ArchiveList items={items} onRestore={handleRestore} />
    </main>
  )
}
