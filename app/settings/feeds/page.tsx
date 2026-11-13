import { listFeeds } from '@/lib/rss/feeds-repo'
import { getDefaultBackfillDays } from '@/lib/app-settings'
import { FeedsClient } from './feeds-client'

export const dynamic = 'force-dynamic'

export default async function FeedsSettingsPage() {
  // Fetch all feeds (including disabled) so the "Show disabled feeds" toggle is
  // an instant client-side filter with no extra server round-trip.
  const [feeds, defaultBackfillDays] = await Promise.all([
    listFeeds({ includeDisabled: true }),
    getDefaultBackfillDays(),
  ])
  return (
    <>
      <h2 className="mt-6 text-xl font-semibold">RSS Feeds</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Feeds polled every 15 minutes. Disabling a feed stops future syncs but
        keeps already-imported items.
      </p>
      <FeedsClient initialFeeds={feeds} initialDefaultBackfillDays={defaultBackfillDays} />
    </>
  )
}
