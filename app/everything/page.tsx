import { Suspense } from 'react'
import { Loader2 } from 'lucide-react'
import { fetchFeedHome, type FeedHomeData } from '@/lib/content/queue-route'
import { getEverythingLastSeen } from '@/lib/app-settings'
import { EverythingClient } from './everything-client'

// The pile (#377): every active feed item, with search and filters. Fresh
// on every request, like home (#189).
export const dynamic = 'force-dynamic'

export const metadata = { title: 'Everything' }

// Same data as home (and /api/queue), so the PICK pills match home exactly.
// newSince is the previous visit (shared across devices); items added after
// it are marked NEW. The client records this visit once it renders.
// serverNow is taken BEFORE the feed read: it becomes this visit's "seen"
// time, so an item added while the read runs is still NEW next time.
async function getInitialData(): Promise<FeedHomeData & { serverNow: number; newSince: string | null }> {
  const serverNow = Date.now()
  const newSince = await getEverythingLastSeen().catch(() => null)
  try {
    const data = await fetchFeedHome()
    return { ...data, serverNow, newSince }
  } catch (error) {
    console.error('[SSR] Failed to fetch the pile:', error)
    return { items: [], curation: null, serverNow, newSince }
  }
}

function LoadingSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  )
}

export default async function EverythingPage() {
  const { items, curation, serverNow, newSince } = await getInitialData()
  return (
    <Suspense fallback={<LoadingSpinner />}>
      <EverythingClient initialItems={items} initialCuration={curation} serverNow={serverNow} newSince={newSince} />
    </Suspense>
  )
}
