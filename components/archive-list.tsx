"use client"

import { useMemo, useState } from "react"
import { RotateCcw, ArrowLeft } from "lucide-react"
import { Button } from "./ui/button"
import { SourceIcon } from "./source-icon"
import { StatusBadge } from "./status-badge"
import { CardThumbnail } from "./card-thumbnail"
import { SearchField } from "./search-field"
import { getPrimaryPlatform } from "@/lib/transform-utils"
import { filterBySearch, hasSearchQuery, noSearchMatchesMessage } from "@/lib/search-filter"
import type { QueueItem } from "@/lib/queue-client"
import Link from "next/link"

interface ArchiveListProps {
  items: QueueItem[]
  onRestore: (item: QueueItem) => Promise<void>
  /** Drives the back-link target and header label. Defaults to feed/'/'. */
  kind?: 'feed' | 'book'
}

// Format publish date for display (e.g., "1/15/2024"). Books only have
// year-granularity dates (#147), so show just the year — matching the
// queue view. UTC year so a tz offset can't roll Jan 1 back to the prior year.
function formatDate(dateString: string | null, isBooks = false): string {
  if (!dateString) return ""
  const date = new Date(dateString)
  if (isBooks) return String(date.getUTCFullYear())
  return date.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" })
}

// Format relative time for "archived X ago"
function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMin / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin} min ago`
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`
  if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`

  // More than a week: show date (include year if not current year)
  const isCurrentYear = date.getFullYear() === now.getFullYear()
  if (isCurrentYear) {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
  }
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

function ArchiveItem({
  item,
  onRestore,
  isBooks,
}: {
  item: QueueItem
  onRestore: (item: QueueItem) => Promise<void>
  isBooks: boolean
}) {
  const statusVariant = item.status === 'Completed' ? 'completed' : 'skip'
  const statusLabel = item.status === 'Completed' ? 'Completed' : 'Skipped'
  // Use statusChangedAt if available, fall back to updatedAt for older items
  const archivedAt = item.statusChangedAt || item.updatedAt

  return (
    // Desktop (#303): the queue cards' two-row grid — text beside the
    // thumbnail on top, meta chips on the bottom row with Restore at its
    // right end.
    <div className="rounded-xl p-4 bg-card border border-border lg:py-3 lg:grid lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:gap-x-4 lg:gap-y-3 lg:items-center">
      {/* Thumbnail floats top-right on mobile, matching the queue cards; text
          flows to its left. Book cover (#168) or feed preview image (#167,
          added to the feed archive in #303). */}
      <div className="float-right ml-3 mb-1 lg:float-none lg:ml-0 lg:mb-0 lg:row-start-1 lg:col-start-1">
        <CardThumbnail
          imageUrl={item.imageUrl}
          platform={getPrimaryPlatform(item.sources)}
          title={item.title}
          shape={isBooks ? "portrait" : "square"}
        />
      </div>
      {/* Desktop (#303): text column, top row of the grid. Plain block on
          mobile, so it still flows around the floated thumbnail. */}
      <div className="lg:row-start-1 lg:col-span-2 lg:min-w-0">
      {/* Title and Status */}
      <div className="mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-lg font-medium lg:text-base">{item.title}</h3>
          <StatusBadge status={statusVariant}>{statusLabel}</StatusBadge>
        </div>
      </div>

      {/* Author */}
      <div className="text-muted-foreground mb-3 lg:mb-0">{item.author}</div>
      </div>

      {/* Source Icons, Publish Date, and Archived Time */}
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3 lg:mb-0 lg:justify-start lg:gap-4 lg:row-start-2 lg:col-start-1 lg:col-span-2">
        <div className="flex items-center gap-2">
          {/* Source Icons */}
          <div className="flex items-center gap-1 px-2 py-1 rounded-full bg-secondary">
            {item.sources.map((source) => (
              <SourceIcon key={source.id} platform={source.platform} className="h-4 w-4 text-secondary-foreground" />
            ))}
          </div>
          {/* Publish Date */}
          {item.publishedOn && (
            <span
              className="inline-flex items-center px-3 py-1 rounded-full bg-secondary text-secondary-foreground"
              style={{ fontSize: "13px" }}
            >
              {formatDate(item.publishedOn, isBooks)}
            </span>
          )}
        </div>
        {/* Archived time */}
        <span className="text-sm text-muted-foreground">
          {formatRelativeTime(archivedAt)}
        </span>
      </div>

      {/* Restore Button */}
      <Button
        onClick={() => onRestore(item)}
        variant="outline"
        className="w-full rounded-lg h-10 border-border font-medium clear-right lg:w-auto lg:row-start-2 lg:col-start-3"
      >
        <RotateCcw className="mr-2 h-4 w-4" />
        Restore to Queue
      </Button>
    </div>
  )
}

export function ArchiveList({ items, onRestore, kind = 'feed' }: ArchiveListProps) {
  const backHref = kind === 'book' ? '/books' : '/'
  const backLabel = kind === 'book' ? 'Back to Books' : 'Back to Queue'
  const headingLabel = kind === 'book' ? 'Books archive' : 'Archive'

  // Text search (#283). Local state: the archive has no other filters and
  // both archive pages share this component, so owning the query here gives
  // feed and books search with no page-level wiring. Resets on reload.
  const [searchQuery, setSearchQuery] = useState('')
  const hasActiveSearch = hasSearchQuery(searchQuery)
  const visibleItems = useMemo(() => filterBySearch(items, searchQuery), [items, searchQuery])

  // Plural follows the TOTAL so "1 of 3 completed or skipped items" reads right.
  const countNoun = `completed or skipped item${items.length !== 1 ? 's' : ''}`
  const countLine = hasActiveSearch
    ? `${visibleItems.length} of ${items.length} ${countNoun}`
    : `${items.length} ${countNoun}`

  return (
    <div className="mx-auto max-w-md p-4 lg:max-w-3xl">
      {/* Header */}
      <div className="mb-6">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors mb-4"
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="text-sm">{backLabel}</span>
        </Link>
        <h1 className="text-2xl font-medium">{headingLabel}</h1>
        <p className="text-muted-foreground mt-1">{countLine}</p>
        <SearchField
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder={kind === 'book' ? 'Search books archive' : 'Search archive'}
          className="mt-4"
        />
      </div>

      {/* Items List */}
      {visibleItems.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-muted-foreground">
            {hasActiveSearch ? noSearchMatchesMessage(searchQuery) : 'No archived items'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {visibleItems.map((item) => (
            <ArchiveItem key={item.id} item={item} onRestore={onRestore} isBooks={kind === 'book'} />
          ))}
        </div>
      )}
    </div>
  )
}
