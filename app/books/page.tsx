import { Suspense } from 'react'
import { fetchActiveItems } from '@/lib/content/queue-route'
import { BooksClient } from './books-client'
import { Loader2 } from 'lucide-react'

// Always render fresh from the DB (#189), matching the home page — no stale
// ISR snapshot keeping a just-completed/skipped book in the active queue.
export const dynamic = 'force-dynamic'

// Shares fetchActiveItems with /api/books so the SSR paint matches the API,
// including engagement scores for the Recommended sort (#255).
async function getInitialBooks() {
  try {
    return await fetchActiveItems('book')
  } catch (error) {
    console.error('[Books SSR] Failed to fetch books queue:', error)
    return []
  }
}

function LoadingSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  )
}

export default async function BooksPage() {
  const initialBooks = await getInitialBooks()
  return (
    <Suspense fallback={<LoadingSpinner />}>
      <BooksClient initialQueue={initialBooks} />
    </Suspense>
  )
}
