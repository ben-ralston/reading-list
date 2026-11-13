"use client"

import type { QueueItem } from '@/lib/queue-client'
import { AWAITING_COMMENTS } from '@/lib/content-status'
import { commentsLink } from '@/lib/comments-link'
import { externalHref } from '@/lib/links'
import { isAwcCommentsSource } from '@/lib/media-type'
import { sourceOpenTarget } from '@/lib/podcast-links'
import { useHydrated } from '@/lib/use-hydrated'
import { Button } from './ui/button'

export function CommentsPrompt({ item, onDone }: {
  item: QueueItem
  onDone: (item: QueueItem) => Promise<void>
}) {
  const hydrated = useHydrated()
  if (item.status !== AWAITING_COMMENTS) return null
  const link = commentsLink(item.sources)
  const episode = item.sources.find((s) => isAwcCommentsSource(s) && s.link)
  return (
    <div
      className="mt-3 clear-both rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <p>Finished listening — have you read the comments?</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {link ? (
          <a className="underline underline-offset-4" href={hydrated ? externalHref(link) : link}
            target="_blank" rel="noopener noreferrer">Open comments</a>
        ) : <span>Comments link unavailable</span>}
        {/* After hydration only: the server-rendered link would be the audio file,
            whose URL holds the feed secret, and on iOS it must open Podcasts. */}
        {episode && hydrated && (
          <a className="underline underline-offset-4" href={sourceOpenTarget(episode, hydrated).href}
            target="_blank" rel="noopener noreferrer">Listen to comments</a>
        )}
        <Button size="sm" variant="outline" onClick={() => onDone(item)}>Done</Button>
      </div>
    </div>
  )
}
