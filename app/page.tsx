import { Suspense } from 'react'
import { fetchFeedHome, type FeedHomeData } from '@/lib/content/queue-route'
import { HomeClient } from './home-client'
import { Loader2 } from 'lucide-react'

// Always render fresh from the DB (#189). ISR (`revalidate = 30`) served a
// stale snapshot in which a just-completed/skipped item lingered in the active
// queue for up to ~30s. For a single-user app the caching win is negligible
// next to that staleness, so the queue paint is now request-time fresh.
export const dynamic = 'force-dynamic'

// Re-export types for backwards compatibility. Type-only: Next.js page modules
// may only export the page component, route segment config, and
// metadata/viewport, so runtime helper re-exports here break the production
// build's page type check (#288).
// Import `hasMediaType`/`getMediaType` from `@/lib/media-type` instead.
export type { MediaFilter, MediaType } from './home-client'

// Server-side data fetching. Shares fetchFeedHome with /api/queue (#377) so
// the SSR paint and the API hand HomeClient the same items and picks; it
// orders them with buildShortlist on both server and client.
// serverNow is the shortlist's clock: hydration recomputes against it, not
// the browser's clock, so the first client render matches the server's.
async function getInitialHome(): Promise<FeedHomeData & { serverNow: number }> {
  try {
    const data = await fetchFeedHome()
    return { ...data, serverNow: Date.now() }
  } catch (error) {
    console.error('[SSR] Failed to fetch queue:', error)
    return { items: [], curation: null, serverNow: Date.now() }
  }
}

function LoadingSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  )
}

export default async function Page() {
  const { items, curation, serverNow } = await getInitialHome()

  return (
    <Suspense fallback={<LoadingSpinner />}>
      <HomeClient initialItems={items} initialCuration={curation} serverNow={serverNow} />
    </Suspense>
  )
}
