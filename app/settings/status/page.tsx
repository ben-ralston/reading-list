import type { ReactNode } from 'react'
import { listRecentRuns, listRecentErrors, type SyncRun } from '@/lib/sync/sync-logs-repo'
import { listFeeds } from '@/lib/rss/feeds-repo'
import { SpotifySyncControl } from './spotify-sync-control'
import { LocalTime } from '@/components/local-time'
import {
  deriveSyncStatus,
  syncStatusDot,
  formatRun,
  selectFailingFeeds,
  assembleErrors,
  relativeTime,
  type RunTone,
} from './status-helpers'

export const dynamic = 'force-dynamic'

const RUN_TONE: Record<RunTone, { glyph: string; cls: string }> = {
  success: { glyph: '✓', cls: 'text-green-600' },
  warn: { glyph: '⚠', cls: 'text-amber-600' },
  error: { glyph: '✗', cls: 'text-red-600' },
  pending: { glyph: '…', cls: 'text-muted-foreground' },
}

function SyncSection({ title, runs, action }: { title: string; runs: SyncRun[]; action?: ReactNode }) {
  const status = deriveSyncStatus(runs)
  const dot = syncStatusDot(status.state)
  const recent = runs.slice(0, 5)
  return (
    <section className="mt-6">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-lg font-medium">{title}</h3>
        {action}
      </div>
      <div className="mt-2 flex items-center gap-2 text-sm">
        <span
          className={`h-2.5 w-2.5 rounded-full ${dot.color}`}
          aria-label={dot.title}
          title={dot.title}
        />
        <span className="font-medium">{dot.title}</span>
        <span className="text-muted-foreground">· last success {relativeTime(status.lastSuccessAt)}</span>
      </div>
      <ul className="mt-3 divide-y divide-border rounded-md border border-border">
        {recent.length === 0 && (
          <li className="px-4 py-6 text-center text-sm text-muted-foreground">
            No sync runs recorded yet.
          </li>
        )}
        {recent.map((r) => {
          const f = formatRun(r)
          const tone = RUN_TONE[f.tone]
          return (
            <li key={r.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <span className={tone.cls} aria-hidden>
                {tone.glyph}
              </span>
              {/* Client-formatted so the time is the viewer's local zone, not
                  the server's UTC (#282). */}
              <LocalTime iso={f.at} className="min-w-28 shrink-0 whitespace-nowrap tabular-nums text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate" title={f.summary}>
                {f.summary}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export default async function StatusPage() {
  // allSettled so one failing read degrades its section to empty, never 500s.
  const [rssRes, askwhocastsRes, askwhocastsPublicRes, spotifyRes, substackRes, goodreadsRes, audibleRes, substackProgressRes, applePodcastsRes, errsRes, feedsRes] =
    await Promise.allSettled([
      listRecentRuns('rss', 10),
      listRecentRuns('askwhocasts', 10),
      listRecentRuns('askwhocasts_public', 10),
      listRecentRuns('spotify', 10),
      listRecentRuns('substack_import', 10),
      listRecentRuns('goodreads', 10),
      listRecentRuns('audible', 10),
      listRecentRuns('substack', 10),
      listRecentRuns('apple_podcasts', 10),
      listRecentErrors(20),
      listFeeds({ includeDisabled: true }),
    ])
  const rssRuns = rssRes.status === 'fulfilled' ? rssRes.value : []
  const askwhocastsRuns = askwhocastsRes.status === 'fulfilled' ? askwhocastsRes.value : []
  const askwhocastsPublicRuns =
    askwhocastsPublicRes.status === 'fulfilled' ? askwhocastsPublicRes.value : []
  const spotifyRuns = spotifyRes.status === 'fulfilled' ? spotifyRes.value : []
  const substackRuns = substackRes.status === 'fulfilled' ? substackRes.value : []
  const goodreadsRuns = goodreadsRes.status === 'fulfilled' ? goodreadsRes.value : []
  const audibleRuns = audibleRes.status === 'fulfilled' ? audibleRes.value : []
  const substackProgressRuns = substackProgressRes.status === 'fulfilled' ? substackProgressRes.value : []
  const applePodcastsRuns = applePodcastsRes.status === 'fulfilled' ? applePodcastsRes.value : []
  const errorRuns = errsRes.status === 'fulfilled' ? errsRes.value : []
  const feeds = feedsRes.status === 'fulfilled' ? feedsRes.value : []

  const errors = assembleErrors(selectFailingFeeds(feeds), errorRuns)

  return (
    <>
      <h2 className="mt-6 text-xl font-semibold">Sync Status</h2>

      <SyncSection title="RSS" runs={rssRuns} />
      <SyncSection title="Askwho Casts" runs={askwhocastsRuns} />
      {/* Public AWC show → Spotify sources (#237) — separate source so its
          health is distinguishable from the private feed's. */}
      <SyncSection title="Askwho Casts (public)" runs={askwhocastsPublicRuns} />
      <SyncSection title="Spotify" runs={spotifyRuns} action={<SpotifySyncControl />} />
      <SyncSection title="Substack import" runs={substackRuns} />
      {/* Goodreads import (#147) — only render once at least one run exists, so
          users who haven't imported don't see a perpetually-empty section. */}
      {goodreadsRuns.length > 0 && <SyncSection title="Goodreads" runs={goodreadsRuns} />}
      {/* Audible sync (#42) — same lazy-render: hidden until the first run. */}
      {audibleRuns.length > 0 && <SyncSection title="Audible" runs={audibleRuns} />}
      {/* Substack progress harvest (#192) — same lazy-render. */}
      {substackProgressRuns.length > 0 && (
        <SyncSection title="Substack progress" runs={substackProgressRuns} />
      )}
      {/* Apple Podcasts progress harvest (#322) — same lazy-render. */}
      {applePodcastsRuns.length > 0 && (
        <SyncSection title="Apple Podcasts progress" runs={applePodcastsRuns} />
      )}

      <section className="mt-8">
        <h3 className="text-lg font-medium">Errors</h3>
        <ul className="mt-3 divide-y divide-border rounded-md border border-border">
          {errors.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">
              No errors. Everything is healthy. 🎉
            </li>
          )}
          {errors.map((e, i) => (
            <li key={`${e.kind}-${e.label}-${i}`} className="flex items-start gap-3 px-4 py-3 text-sm">
              <span className="mt-0.5 text-red-500" aria-hidden>
                ⚠
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{e.label}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                    {e.kind === 'feed' ? 'feed' : 'sync'}
                  </span>
                  {e.count != null && e.count > 1 && (
                    <span className="text-xs text-muted-foreground">{e.count}× in a row</span>
                  )}
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">{relativeTime(e.at)}</span>
                </div>
                <div className="mt-0.5 truncate text-xs text-destructive" title={e.message}>
                  {e.message}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </>
  )
}
