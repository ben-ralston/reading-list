"use client"

import { useState, memo } from "react"
import dynamic from "next/dynamic"
import { Check, SkipForward, GripVertical, MoreHorizontal, ListOrdered, ArrowDown, ArrowUp, ArrowLeft, ChevronDown, RotateCcw, Play, Sparkles, Archive, Plus, BookOpen, Newspaper, Headphones, Settings, AudioLines, AlertCircle, Loader2, Undo2 } from "lucide-react"
import Link from "next/link"
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
} from "@dnd-kit/core"
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { Button } from "./ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu"
import { SourceIcon } from "./source-icon"
import { FilterSheet, FilterSummaryChips } from "./filter-sheet"
import { SearchField } from "./search-field"
import { hasSearchQuery, noSearchMatchesMessage } from "@/lib/search-filter"
import { activeSheetFilterCount } from "@/lib/sheet-filter-count"
import { CardThumbnail } from "./card-thumbnail"
import { ProgressBar } from "./progress-bar"
import { StatusBadge } from "./status-badge"
import { NewPill, PickPill, PickReason } from "./pick-reason"
const AddEntryDialog = dynamic(() => import("./add-entry-dialog").then(m => ({ default: m.AddEntryDialog })))
import { SummarySection } from "./summary-section"
import { SummaryOneLiner } from "./summary-one-liner"
import type { SummaryData } from "@/lib/summary-data"
import type { QueueItem, SortDirection } from "@/lib/queue-client"
import { transformToDisplayItem, getPrimarySource, getPrimaryPlatform, getPrimaryLink, heroStartSource, getOrderedSources, repeatedPlatforms, formatLength, type DisplayItem } from "@/lib/transform-utils"
import { hasMediaType, type MediaFilter } from "@/lib/media-type"
import { type AuthorOption } from "@/lib/author-filter"
import { type ReadState, type ReadStateOption } from "@/lib/read-state"
import { canListenInReader } from "@/lib/reader/elevenreader"
import { canConvertCommentsWithAwc, canConvertWithAwc, hasAwcAudio, hasAwcCommentsAudio } from "@/lib/awc/eligibility"
import { awcBadgeLabel, isActiveStage, isShortEpisode, type AwcKind } from "@/lib/awc/stages"
import type { AwcAgentStatus } from "@/lib/awc/polling"
import { getSpotifyResume } from "@/lib/spotify/resume-link"
import { externalHref } from "@/lib/links"
import { sourceOpenTarget, type SourceOpenTarget } from "@/lib/podcast-links"
import { CommentsPrompt } from "./comments-prompt"
import { AWAITING_COMMENTS, isStartedStatus } from "@/lib/content-status"
import { useHydrated } from "@/lib/use-hydrated"

// Agent health before the first poll: unknown, rendered as not stale.
const AWC_AGENT_UNKNOWN: AwcAgentStatus = { stale: false, checkedAt: 0 }

interface ReadingListProps {
  items: QueueItem[]
  onMarkComplete: (item: QueueItem) => Promise<void>
  onSkip: (item: QueueItem) => Promise<void>
  onToggleStarted: (item: QueueItem) => Promise<void>
  onStartItem: (item: QueueItem) => Promise<void>
  onMakeNext: (item: QueueItem) => Promise<unknown>
  // #171: hand a text item off to ElevenReader. Feed-only — books don't pass it.
  onListen?: (item: QueueItem) => Promise<void>
  // #226/#317: queue a text item for the Askwho Casts agent. Feed-only —
  // books don't pass it.
  onConvert?: (item: QueueItem, kind?: AwcKind) => Promise<void>
  // #317: manual copy-and-open fallback, offered after an agent run failed.
  onConvertManually?: (item: QueueItem) => Promise<void>
  // #317: Mac agent health from polling ({stale:false} until the first poll).
  awcAgent?: AwcAgentStatus
  // Drag-to-reorder and the sort menu: the books queue view only, plus
  // Newest / Oldest on the feed's pile view (#377).
  onReorder?: (reorderedItems: QueueItem[], movedItemId: number) => Promise<void>
  onRefresh: () => void
  sortDirection?: SortDirection
  onSortChange?: (direction: SortDirection) => void
  // Search + filter props: not used by the feed home view (#377), which shows
  // the picks only; inert defaults below.
  mediaFilter?: MediaFilter
  onMediaFilterChange?: (filter: MediaFilter) => void
  mediaCounts?: { all: number; audio: number; text: number }
  // Author multi-select filter (#202). Options come pre-scoped from
  // useQueueFilters; selection state stores display labels.
  authorOptions?: AuthorOption[]
  selectedAuthors?: string[]
  onSelectedAuthorsChange?: (labels: string[]) => void
  // Read-state multi-select filter (#227). Options come pre-scoped (and
  // per-kind) from useQueueFilters; selection state stores ReadState keys.
  readStateOptions?: ReadStateOption[]
  selectedReadStates?: ReadState[]
  onSelectedReadStatesChange?: (states: ReadState[]) => void
  // Text search (#283). State lives in useQueueFilters; deliberately NOT
  // part of FilterControlProps so it stays out of the sheet badge/chips.
  searchQuery?: string
  onSearchQueryChange?: (query: string) => void
  isAddDialogOpen: boolean
  onAddDialogOpenChange: (open: boolean) => void
  // Drives kind-specific UI: archive link target, empty-state copy, and the
  // visibility of the Spotify sync button. Defaults to 'feed' so existing
  // callers (the home page) keep working without any prop changes.
  kind?: 'feed' | 'book'
  // #377. 'queue' = the books list (hero + draggable ranked list, all four
  // sorts). The feed uses 'home' (hero + Claude's picks, no search/filter/sort)
  // and 'pile' (/everything: every item as a card, Newest / Oldest).
  view?: 'queue' | 'home' | 'pile'
  // Home: "Not now" in every card's and the hero's ••• menu.
  onNotNow?: (item: QueueItem) => Promise<unknown>
  // Home: Claude's one-line reason per picked item id.
  reasons?: ReadonlyMap<number, string>
  // Pile: ids currently shown on home: highlighted card, PICK pill, Not now.
  pickIds?: ReadonlySet<number>
  // Pile: ids added since the previous visit, marked NEW.
  newIds?: ReadonlySet<number>
  // Home: quiet "Picks updated 2h ago" line; stale after a day.
  freshness?: { label: string; stale: boolean }
  // Home: count for the "Everything else · N items" link.
  everythingCount?: number
  // Called after the Add entry dialog adds something (the page reloads).
  onEntryAdded?: () => void
}

interface SortableQueueItemProps {
  item: DisplayItem
  originalItem: QueueItem
  // Books queue view only (#377): the feed never drags.
  draggable: boolean
  sortDirection: SortDirection
  // True when any filter (media, author, or read-state) is active — disables reordering.
  filtersActive: boolean
  onMakeNext: (item: QueueItem) => Promise<unknown>
  onMarkComplete: (item: QueueItem) => Promise<void>
  onSkip: (item: QueueItem) => Promise<void>
  onToggleStarted: (item: QueueItem) => Promise<void>
  onListen?: (item: QueueItem) => Promise<void>
  onConvert?: (item: QueueItem, kind?: AwcKind) => Promise<void>
  onConvertManually?: (item: QueueItem) => Promise<void>
  onNotNow?: (item: QueueItem) => Promise<unknown>
  reason?: string | null
  isPick?: boolean
  isNew?: boolean
  awcAgent: AwcAgentStatus
  formatDate: (dateString: string | null) => string
  isBooks: boolean
}

// Inner content of a source "Open on …" menu anchor. When the platform repeats
// on this item (#245) the show name is shown as a muted, truncated second line
// so two Spotify episodes are distinguishable; otherwise it's the plain single
// line exactly as before. The disambiguating aria-label keeps the accessible
// name coherent ("Open on Spotify — AI Article Readings") despite Radix
// collapsing whitespace across the span boundary.
function sourceMenuItemAriaLabel(target: SourceOpenTarget): string | undefined {
  return target.sublabel ? `${target.label} — ${target.sublabel}` : undefined
}

function SourceMenuItemContent({
  platform,
  target,
}: {
  platform: string
  target: SourceOpenTarget
}) {
  if (!target.sublabel) {
    return (
      <>
        <SourceIcon platform={platform} className="mr-2 h-4 w-4" />
        <span>{target.label}</span>
      </>
    )
  }
  return (
    <>
      <SourceIcon platform={platform} className="mr-2 h-4 w-4 shrink-0" />
      <span className="flex min-w-0 flex-col">
        <span>{target.label}</span>
        <span className="truncate text-xs text-muted-foreground">{target.sublabel}</span>
      </span>
    </>
  )
}

// Small pill shown on a card once the item has been handed to ElevenReader (#171).
function SentToReaderBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground"
      style={{ fontSize: "12px" }}
    >
      <Headphones className="h-3 w-3" />
      Sent
    </span>
  )
}

// "Listen in ElevenReader" dropdown action; relabels to "Listen again" once sent (#171).
function ListenMenuItem({
  item,
  onListen,
}: {
  item: QueueItem
  onListen: (item: QueueItem) => Promise<void>
}) {
  const sent = item.sentToReaderAt != null
  return (
    <DropdownMenuItem
      className="cursor-pointer"
      onClick={(e) => {
        e.stopPropagation()
        onListen(item)
      }}
    >
      <Headphones className="mr-2 h-4 w-4" />
      <span>{sent ? 'Listen again' : 'Listen in ElevenReader'}</span>
    </DropdownMenuItem>
  )
}

// "Resume on Spotify (~MM:SS)" dropdown action (#194): dual-source items
// (Substack post + its Spotify episode) map the harvested read position onto
// the episode duration and deep-link to that timestamp. Real anchor for the
// same universal-link reason as the "Open on …" items (#197); the ~ in the
// label flags the crude percent→time mapping. Renders nothing when the item
// isn't eligible (see getSpotifyResume).
function SpotifyResumeMenuItem({ item, hydrated }: { item: QueueItem; hydrated: boolean }) {
  const resume = getSpotifyResume(item)
  if (!resume) return null
  return (
    <DropdownMenuItem asChild className="cursor-pointer">
      <a
        href={hydrated ? externalHref(resume.url) : resume.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
      >
        <Play className="mr-2 h-4 w-4" />
        <span>{`Resume on Spotify (${resume.label})`}</span>
      </a>
    </DropdownMenuItem>
  )
}

// Live Askwho Casts conversion pill (#317): the stage while the Mac agent
// works, "Failed" until retried. agent comes from client polling ({stale:
// false} during SSR), so the "Mac offline" branch never runs at hydration.
function AwcConversionBadge({ item, agent }: { item: QueueItem; agent: AwcAgentStatus }) {
  const conversion = item.awcConversion
  if (!conversion) return null
  const short = isShortEpisode(conversion)
  // Once it has an Askwho Casts episode there's nothing left to report (covers
  // a 'failed' row whose episode arrived anyway), unless the episode looks too
  // short to be the whole article (#363). Other audio doesn't count (#364), and
  // each kind only answers for its own episode (#368).
  const hasOwnEpisode = conversion.kind === 'comments' ? hasAwcCommentsAudio(item) : hasAwcAudio(item)
  if (!short && hasOwnEpisode) return null
  const label = awcBadgeLabel(conversion, agent.stale, agent.checkedAt)
  if (!label) return null
  const failed = conversion.status === 'failed'
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full ${failed ? 'bg-destructive/10 text-destructive' : 'bg-secondary text-secondary-foreground'}`}
      style={{ fontSize: "12px" }}
      title={(failed || short) && conversion.error ? conversion.error : undefined}
    >
      {failed || short ? <AlertCircle className="h-3 w-3" /> : <Loader2 className="h-3 w-3 animate-spin" />}
      {label}
    </span>
  )
}

// "Convert with Askwho Casts" dropdown action (#226 → #317): queues the item
// for the Mac agent, which submits it and reports stages; the finished episode
// is attached later by the askwhocasts-sync cron, which also hides this via
// canConvertWithAwc. Disabled while a
// conversion is active; after a failure offers Retry plus the old
// copy-and-open handoff as a manual fallback.
function ConvertMenuItem({
  item,
  kind = 'article',
  onConvert,
  onConvertManually,
}: {
  item: QueueItem
  kind?: AwcKind
  onConvert: (item: QueueItem, kind?: AwcKind) => Promise<void>
  onConvertManually?: (item: QueueItem) => Promise<void>
}) {
  const comments = kind === 'comments'
  const conversion = item.awcConversion
  const ownKind = (conversion?.kind ?? 'article') === kind
  const label = comments ? 'Convert comments with Askwho Casts' : 'Convert with Askwho Casts'
  // One conversion at a time per item (#368), so the other option waits too.
  if (isActiveStage(conversion?.status)) {
    return (
      <DropdownMenuItem disabled>
        <AudioLines className="mr-2 h-4 w-4" />
        <span>{!ownKind ? label : comments ? 'Converting comments…' : 'Converting…'}</span>
      </DropdownMenuItem>
    )
  }
  const failed = ownKind && conversion?.status === 'failed'
  return (
    <>
      <DropdownMenuItem
        className="cursor-pointer"
        onClick={(e) => {
          e.stopPropagation()
          if (comments) onConvert(item, 'comments')
          else onConvert(item)
        }}
      >
        <AudioLines className="mr-2 h-4 w-4" />
        <span>{!failed ? label : comments ? 'Retry comments with Askwho Casts' : 'Retry Askwho Casts'}</span>
      </DropdownMenuItem>
      {failed && !comments && onConvertManually && (
        <DropdownMenuItem
          className="cursor-pointer"
          onClick={(e) => {
            e.stopPropagation()
            onConvertManually(item)
          }}
        >
          <AudioLines className="mr-2 h-4 w-4" />
          <span>Open Askwho Casts manually</span>
        </DropdownMenuItem>
      )}
    </>
  )
}

// "Not now" (#377): back to the pile without skipping; off home for a while.
function NotNowMenuItem({ item, onNotNow }: { item: QueueItem; onNotNow: (item: QueueItem) => Promise<unknown> }) {
  return (
    <DropdownMenuItem
      className="cursor-pointer"
      onClick={(e) => {
        e.stopPropagation()
        onNotNow(item)
      }}
    >
      <Undo2 className="mr-2 h-4 w-4" />
      <span>Not now</span>
    </DropdownMenuItem>
  )
}

// Desktop (#303) card body grid. Top row = thumbnail | title + author (and
// badges), indented beside the thumbnail; then the one-liner / progress /
// comments prompt full-width from the card's left edge, below the thumbnail;
// last row = chips from the left edge.
// Chips always sit on the bottom row, so they never jump up beside the title
// when there's horizontal room. Only the top row is placed explicitly: the
// rest auto-flow, so a card with no one-liner/progress (the wrapper hides
// when empty) gets no extra row gap. The auto third column is zero-width.
const CARD_GRID = "lg:grid lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:gap-x-4 lg:gap-y-3 lg:items-center"
const CARD_THUMB = "lg:row-start-1 lg:col-start-1"
const CARD_TEXT = "lg:row-start-1 lg:col-start-2 lg:col-span-2 lg:min-w-0"
// Plain block on mobile (no BFC), so its text still wraps around the float.
const CARD_BELOW = "lg:col-span-3 lg:min-w-0 lg:empty:hidden lg:[&>:first-child]:mt-0"
const CARD_CHIPS = "lg:col-start-1 lg:col-span-2"

function SortableQueueItem({
  item,
  originalItem,
  draggable,
  sortDirection,
  filtersActive,
  onMakeNext,
  onMarkComplete,
  onSkip,
  onToggleStarted,
  onListen,
  onConvert,
  onConvertManually,
  onNotNow,
  reason,
  isPick,
  isNew,
  awcAgent,
  formatDate,
  isBooks,
}: SortableQueueItemProps) {
  const hydrated = useHydrated()
  const [showSummary, setShowSummary] = useState(false)
  const [summaryMounted, setSummaryMounted] = useState(false)
  const [localSummary, setLocalSummary] = useState<{ summary: string; generatedAt: string; summaryData: SummaryData | null } | null>(null)

  // Disable dragging when not in queue sort mode or when any filter is active
  // (dragging a filtered subset would silently corrupt positions for hidden items)
  const isDragDisabled = !draggable || sortDirection !== 'queue' || filtersActive

  // Per-source picker entries (effective primary first, position-aware).
  // The feed views ignore legacy queue positions (#377).
  const orderedSources = getOrderedSources(item.sources, draggable ? item.queuePosition : null)
  // Show the per-source label only for platforms this item carries more than
  // once, so single-source items keep the clean "Open on Spotify" (#245).
  const cardRepeatedPlatforms = repeatedPlatforms(orderedSources)

  // Feed-card extras (#167): a preview thumbnail and a read/listen length
  // estimate. Feed-only — books keep the text-only card (covers are #168).
  const lengthLabel = formatLength(item)

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id, disabled: isDragDisabled })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-card
      data-pick={isPick ? 'true' : 'false'}
      className={`relative rounded-xl p-4 lg:py-3 transition-colors select-none ${isPick
        ? "border-2 border-primary bg-primary/10"
        : "bg-card border border-border hover:border-muted-foreground/30"
        } ${isDragging ? "shadow-lg" : ""}`}
    >
      <div className="relative lg:flex lg:items-center lg:gap-3">
      {/* Drag Handle - only in queue mode with no filter. Vertically centered,
          but clamped to sit just below the floated top-right thumbnail on short
          cards so the grip never overlaps the cover. The clamp floor is taller
          for books (portrait cover h-20 = 80px) than feeds (square h-14 = 56px). */}
      {!isDragDisabled && (
        <div
          {...attributes}
          {...listeners}
          className={`absolute right-0 ${isBooks ? 'top-[max(50%,96px)]' : 'top-[max(50%,72px)]'} -translate-y-1/2 text-muted-foreground cursor-grab active:cursor-grabbing touch-none z-10 lg:static lg:translate-y-0 lg:order-last`}
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="h-6 w-6" />
        </div>
      )}

      {/* Card tap = "make it next" — promotes the item to queue position 1,
          which every sort mode pins as the hero, so the tap always has a
          visible result. */}
      <div
        className={`${CARD_GRID} lg:flex-1 lg:min-w-0 cursor-pointer`}
        onClick={() => onMakeNext(originalItem)}
      >
        {/* Option B (#167): thumbnail floats top-right; all text flows full-width
            on the left, wrapping beside the thumbnail and reclaiming the width
            below it (Medium / NYT-style list item). Books (#168) use the same
            placement with a portrait cover. */}
        <div className={`float-right ml-3 mb-1 lg:float-none lg:ml-0 lg:mb-0 ${CARD_THUMB}`}>
          <CardThumbnail
            imageUrl={item.imageUrl}
            platform={getPrimaryPlatform(item.sources)}
            title={item.title}
            shape={isBooks ? "portrait" : "square"}
          />
        </div>
        {/* Desktop (#303): text column, top row of the card grid. Plain block
            on mobile, so it still flows around the floated thumbnail. */}
        <div className={CARD_TEXT}>
        {/* Title with Status Badge */}
        <div className="mb-2">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-lg font-medium lg:text-base">{item.title}</h3>
            {isStartedStatus(item.status) && (
              <StatusBadge status={item.status === AWAITING_COMMENTS ? "awaiting-comments" : "in-progress"} />
            )}
            {originalItem.sentToReaderAt != null && <SentToReaderBadge />}
            <AwcConversionBadge item={originalItem} agent={awcAgent} />
            {isPick && <PickPill />}
            {isNew && <NewPill />}
          </div>
        </div>

        {/* Author */}
        <div className="text-muted-foreground">{item.author}</div>
        {reason && <PickReason text={reason} />}
        </div>

        {/* Desktop (#303): one-liner / progress / comments, full width below
            the thumbnail row. */}
        <div className={CARD_BELOW}>
        {!isBooks && (
          <SummaryOneLiner
            summaryData={localSummary ? localSummary.summaryData : originalItem.summaryData}
            expanded={showSummary}
            className="mt-1 pr-10 lg:pr-0"
          />
        )}

        {/* Progress Bar — full width below the thumbnail/title row. */}
        {item.progressPercent !== undefined && (
          <ProgressBar progress={item.progressPercent} className="mt-3" />
        )}

        <CommentsPrompt item={originalItem} onDone={onMarkComplete} />
        </div>

        {/* Source and Date Pills — full width at the card's left edge. */}
        <div className={`flex items-center gap-2 flex-wrap mt-3 lg:mt-0 ${CARD_CHIPS}`}>
          {/* Source Icons */}
          <div className="flex items-center gap-1 px-2 py-1 rounded-full bg-secondary">
            {item.sources.map((source) => (
              <SourceIcon key={source.id} platform={source.platform} className="h-4 w-4 text-secondary-foreground" />
            ))}
          </div>
          {/* Date */}
          {item.publishedOn && (
            <span
              className="inline-flex items-center px-3 py-1 rounded-full bg-secondary text-secondary-foreground"
              style={{ fontSize: "13px" }}
            >
              {formatDate(item.publishedOn)}
            </span>
          )}
          {/* Read/listen length estimate (#167) — feed only, omitted when unknown. */}
          {!isBooks && lengthLabel && (
            <span
              className="inline-flex items-center px-3 py-1 rounded-full bg-secondary text-secondary-foreground"
              style={{ fontSize: "13px" }}
            >
              {lengthLabel}
            </span>
          )}
          {/* Sparkle toggle for AI Summary — books don't get AI summaries (#147) */}
          {!isBooks && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                if (!summaryMounted) setSummaryMounted(true)
                setShowSummary(!showSummary)
              }}
              className="flex items-center justify-center w-10 h-10 rounded-full hover:bg-accent transition-colors"
              title={showSummary ? "Hide AI Summary" : "Show AI Summary"}
            >
              <Sparkles className={`h-5 w-5 ${(localSummary?.summary ?? originalItem.summary) ? "text-primary fill-primary" : "text-muted-foreground"}`} />
            </button>
          )}
          {/* More Actions Menu — kept inline (grouped with the meta row), NOT
              pinned to the right edge, so it never collides with the drag handle
              which now lives on the right edge below the floated thumbnail. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="flex items-center justify-center w-10 h-10 rounded-full hover:bg-accent transition-colors"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal className="h-5 w-5 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {orderedSources.map((source) => {
                // Books mode (#147) introduced link-less sources (Physical /
                // Library / Other) — render those as a disabled label rather
                // than a clickable "Open on …" item.
                const link = source.link ?? ''
                const isHttp = link.startsWith('http://') || link.startsWith('https://')
                // Real anchor (not window.open) so iOS treats the tap as
                // universal-link-eligible — see lib/links.ts (#197). The
                // x-safari transform is hydration-gated: SSR has no navigator,
                // so the first client render must emit the same plain href.
                if (isHttp) {
                  // Askwho Casts sources swap to the Apple Podcasts Library
                  // universal link on hydrated iOS (#236); everything else
                  // keeps the hydration-gated x-safari treatment (#197).
                  const target = sourceOpenTarget(
                    source,
                    hydrated,
                    cardRepeatedPlatforms.has(source.platform),
                  )
                  return (
                    <DropdownMenuItem key={source.id} asChild className="cursor-pointer">
                      <a
                        href={target.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={sourceMenuItemAriaLabel(target)}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <SourceMenuItemContent platform={source.platform} target={target} />
                      </a>
                    </DropdownMenuItem>
                  )
                }
                return (
                  <DropdownMenuItem key={source.id} disabled>
                    <SourceIcon platform={source.platform} className="mr-2 h-4 w-4" />
                    <span>{source.platform}</span>
                  </DropdownMenuItem>
                )
              })}
              {/* Resume the companion Spotify episode at the read position — #194 */}
              <SpotifyResumeMenuItem item={originalItem} hydrated={hydrated} />
              {/* Listen in ElevenReader (text feed items only) — #171 */}
              {onListen && canListenInReader(originalItem, isBooks) && (
                <ListenMenuItem item={originalItem} onListen={onListen} />
              )}
              {/* Convert with Askwho Casts (feed items with an article) — #226, #364 */}
              {onConvert && canConvertWithAwc(originalItem, isBooks) && (
                <ConvertMenuItem item={originalItem} onConvert={onConvert} onConvertManually={onConvertManually} />
              )}
              {onConvert && canConvertCommentsWithAwc(originalItem, isBooks) && (
                <ConvertMenuItem item={originalItem} kind="comments" onConvert={onConvert} />
              )}
              <>
                  <DropdownMenuItem
                    className="cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation()
                      onMarkComplete(originalItem)
                    }}
                  >
                    <Check className="mr-2 h-4 w-4" />
                    <span>Mark Complete</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation()
                      onSkip(originalItem)
                    }}
                  >
                    <SkipForward className="mr-2 h-4 w-4" />
                    <span>Skip</span>
                  </DropdownMenuItem>
                  {originalItem.status !== AWAITING_COMMENTS && (
                  <DropdownMenuItem
                    className="cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation()
                      onToggleStarted(originalItem)
                    }}
                  >
                    {originalItem.status === "In Progress" ? (
                      <>
                        <RotateCcw className="mr-2 h-4 w-4" />
                        <span>Not Started</span>
                      </>
                    ) : (
                      <>
                        <Play className="mr-2 h-4 w-4" />
                        <span>Mark Started</span>
                      </>
                    )}
                  </DropdownMenuItem>
                  )}
              </>
              {onNotNow && <NotNowMenuItem item={originalItem} onNotNow={onNotNow} />}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

      </div>
      </div>
      {!isBooks && summaryMounted && (
        <div className={showSummary ? "" : "hidden"}>
          <SummarySection
            contentItemId={originalItem.id}
            summary={localSummary?.summary ?? originalItem.summary}
            summaryGeneratedAt={localSummary?.generatedAt ?? originalItem.summaryGeneratedAt}
            itemTitle={item.title}
            itemLink={getPrimaryLink(item.sources)}
            summaryData={localSummary ? localSummary.summaryData : originalItem.summaryData}
            onSummaryGenerated={(summary, generatedAt, summaryData) => setLocalSummary({ summary, generatedAt, summaryData })}
          />
        </div>
      )}
    </div>
  )
}

/** Card component for DragOverlay - shows what's being dragged */
export function QueueItemCard({
  item,
  formatDate,
  isBooks = false,
}: {
  item: DisplayItem
  formatDate: (dateString: string | null) => string
  isBooks?: boolean
}) {
  const lengthLabel = formatLength(item)

  return (
    <div
      className="relative rounded-xl p-4 select-none lg:flex lg:items-center lg:gap-3 lg:py-3 bg-card border border-border shadow-lg ring-2 ring-ring"
    >
      <div className={`absolute right-0 ${isBooks ? 'top-[max(50%,96px)]' : 'top-[max(50%,72px)]'} -translate-y-1/2 w-14 flex justify-center text-muted-foreground lg:static lg:translate-y-0 lg:order-last lg:w-auto`}>
        <GripVertical className="h-8 w-8" />
      </div>

      <div className={`pr-8 lg:pr-0 lg:flex-1 lg:min-w-0 ${CARD_GRID}`}>
        <div className={`float-right ml-3 mb-1 lg:float-none lg:ml-0 lg:mb-0 ${CARD_THUMB}`}>
          <CardThumbnail
            imageUrl={item.imageUrl}
            platform={getPrimaryPlatform(item.sources)}
            title={item.title}
            shape={isBooks ? "portrait" : "square"}
          />
        </div>
        <div className={CARD_TEXT}>
        <div className="mb-2">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-lg font-medium lg:text-base">{item.title}</h3>
            {isStartedStatus(item.status) && (
              <StatusBadge status={item.status === AWAITING_COMMENTS ? "awaiting-comments" : "in-progress"} />
            )}
          </div>
        </div>
        <div className="text-muted-foreground">{item.author}</div>
        </div>
        <div className={CARD_BELOW}>
        {!isBooks && <SummaryOneLiner summaryData={item.summaryData} className="mt-1 pr-10 lg:pr-0" />}
        {item.progressPercent !== undefined && (
          <ProgressBar progress={item.progressPercent} className="mt-3" />
        )}
        </div>
        <div className={`flex items-center gap-2 flex-wrap mt-3 lg:mt-0 ${CARD_CHIPS}`}>
          <div className="flex items-center gap-1 px-2 py-1 rounded-full bg-secondary">
            {item.sources.map((source) => (
              <SourceIcon key={source.id} platform={source.platform} className="h-4 w-4 text-secondary-foreground" />
            ))}
          </div>
          {item.publishedOn && (
            <span
              className="inline-flex items-center px-3 py-1 rounded-full bg-secondary text-secondary-foreground"
              style={{ fontSize: "13px" }}
            >
              {formatDate(item.publishedOn)}
            </span>
          )}
          {!isBooks && lengthLabel && (
            <span
              className="inline-flex items-center px-3 py-1 rounded-full bg-secondary text-secondary-foreground"
              style={{ fontSize: "13px" }}
            >
              {lengthLabel}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// Sort dropdown config: trigger is the compact uppercase toolbar label, menu
// the full item label. Append new modes last — component tests index menu
// triggers by DOM order.
const SORT_OPTIONS: {
  value: SortDirection
  Icon: typeof ListOrdered
  trigger: string
  menu: string
}[] = [
  { value: 'queue', Icon: ListOrdered, trigger: 'QUEUE', menu: 'Queue order' },
  { value: 'newest', Icon: ArrowDown, trigger: 'NEWEST', menu: 'Newest first' },
  { value: 'oldest', Icon: ArrowUp, trigger: 'OLDEST', menu: 'Oldest first' },
  { value: 'recommended', Icon: Sparkles, trigger: 'FOR YOU', menu: 'Recommended' },
]

// The feed's pile view sorts by date only (#377).
const PILE_SORT_OPTIONS = SORT_OPTIONS.filter((o) => o.value === 'newest' || o.value === 'oldest')

const noopAsync = () => {}
const NO_MEDIA_COUNTS = { all: 0, audio: 0, text: 0 }
const NO_OPTIONS: never[] = []

export const ReadingList = memo(function ReadingList({
  items,
  onMarkComplete,
  onSkip,
  onToggleStarted,
  onStartItem,
  onMakeNext,
  onListen,
  onConvert,
  onConvertManually,
  awcAgent = AWC_AGENT_UNKNOWN,
  onReorder,
  onRefresh,
  sortDirection = 'queue',
  onSortChange,
  mediaFilter = 'all',
  onMediaFilterChange = noopAsync,
  mediaCounts = NO_MEDIA_COUNTS,
  authorOptions = NO_OPTIONS,
  selectedAuthors = NO_OPTIONS,
  onSelectedAuthorsChange = noopAsync,
  readStateOptions = NO_OPTIONS,
  selectedReadStates = NO_OPTIONS,
  onSelectedReadStatesChange = noopAsync,
  searchQuery = '',
  onSearchQueryChange = noopAsync,
  isAddDialogOpen,
  onAddDialogOpenChange,
  kind = 'feed',
  view = 'queue',
  onNotNow,
  reasons,
  pickIds,
  newIds,
  freshness,
  everythingCount,
  onEntryAdded,
}: ReadingListProps) {
  const isBooks = kind === 'book'
  const isHome = view === 'home'
  const isPile = view === 'pile'
  const sortOptions = isPile ? PILE_SORT_OPTIONS : SORT_OPTIONS
  const archiveHref = isBooks ? '/books/archive' : '/archive'
  const emptyHeading = isBooks ? 'No books yet' : 'All caught up!'
  const emptyBody = isBooks
    ? 'Add a book or import your Goodreads library to get started.'
    : 'Your queue is empty.'
  const hydrated = useHydrated()
  const [activeId, setActiveId] = useState<number | null>(null)
  const [showCurrentItemSummary, setShowCurrentItemSummary] = useState(false)
  const [currentItemSummaryMounted, setCurrentItemSummaryMounted] = useState(false)
  const [localCurrentSummary, setLocalCurrentSummary] = useState<{ summary: string; generatedAt: string; summaryData: SummaryData | null } | null>(null)

  // Reset summary state when current item changes.
  // Adjust state during render (see https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes).
  const currentItemId = items[0]?.id
  const [prevCurrentItemId, setPrevCurrentItemId] = useState(currentItemId)
  if (prevCurrentItemId !== currentItemId) {
    setPrevCurrentItemId(currentItemId)
    setShowCurrentItemSummary(false)
    setCurrentItemSummaryMounted(false)
    setLocalCurrentSummary(null)
  }

  // Set up sensors for pointer (mouse), touch, and keyboard support
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // Require 8px drag before starting
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 200, // Long press delay for touch
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  // Top-of-page toolbar and filter controls (#202, #241). Built as consts so
  // the empty state can render them too — otherwise filtering down to zero
  // items would strand the user with no way to clear the filter.
  const hasActiveSearch = hasSearchQuery(searchQuery)
  const hasSheetFilters = activeSheetFilterCount(mediaFilter, selectedReadStates, selectedAuthors) > 0
  const hasActiveFilters = hasActiveSearch || hasSheetFilters
  // Search-only empty state gets search copy + a Clear search CTA. When a sheet
  // filter is also active, clearing the search alone may not help, so name both.
  const searchOnlyEmpty = hasActiveSearch && !hasSheetFilters
  const listNoun = isBooks ? 'books' : 'queue'
  const emptyState = searchOnlyEmpty
    ? {
        heading: noSearchMatchesMessage(searchQuery),
        body: `Try a different search, or clear it to see your ${listNoun}.`,
      }
    : hasActiveFilters
      ? {
          heading: 'No matching items',
          body: hasActiveSearch
            ? `Clear the search or adjust the filters to see your ${listNoun}.`
            : `Adjust or clear the filters to see your ${listNoun}.`,
        }
      : { heading: emptyHeading, body: emptyBody }

  const activeSortOption = sortOptions.find((o) => o.value === sortDirection) ?? sortOptions[0]

  const filterControlProps = {
    mediaFilter,
    onMediaFilterChange,
    mediaCounts,
    authorOptions,
    selectedAuthors,
    onSelectedAuthorsChange,
    readStateOptions,
    selectedReadStates,
    onSelectedReadStatesChange,
  }

  // Home (#377): "Everything else · N items", the way into the pile.
  const everythingLink = isHome ? (
    <Link
      href="/everything"
      className="mt-4 flex w-full items-center justify-center rounded-xl border border-dashed border-muted-foreground/50 p-3 font-medium text-foreground hover:bg-accent transition-colors"
    >
      {`Everything else · ${everythingCount ?? 0} items`}
    </Link>
  ) : null

  const toolbar = (
    <div className="flex items-center justify-end gap-1 mb-2 lg:mb-0 lg:order-last">
      {isHome && freshness && (
        <span
          data-stale={freshness.stale ? 'true' : 'false'}
          className={`mr-auto truncate text-xs ${freshness.stale ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}
        >
          {freshness.label}
        </span>
      )}
      {!isHome && <FilterSheet {...filterControlProps} />}
      <button
        onClick={() => onAddDialogOpenChange(true)}
        className="flex items-center gap-1 px-2 py-1 rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        title={isBooks ? 'Add book' : 'Add entry'}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      <Link
        href={archiveHref}
        className="flex items-center gap-1 px-2 py-1 rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
      >
        <Archive className="h-3.5 w-3.5" />
        <span style={{ fontSize: "11px", letterSpacing: "0.06em" }}>ARCHIVE</span>
      </Link>
      {/* Cross-mode toggle: feed page → /books (BookOpen),
          books page → / (Newspaper). The settings gear links straight to
          /settings/feeds — the settings pages carry their own cross-nav
          (Feeds / Status / Books-import / Share), so no dropdown here. */}
      {isPile ? (
        <Link
          href="/"
          className="flex items-center gap-1 px-2 py-1 rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          title="Back to picks"
          aria-label="Back to picks"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span style={{ fontSize: "11px", letterSpacing: "0.06em" }}>PICKS</span>
        </Link>
      ) : isBooks ? (
        <Link
          href="/"
          className="flex items-center gap-1 px-2 py-1 rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          title="Feed"
          aria-label="Feed"
        >
          <Newspaper className="h-3.5 w-3.5" />
        </Link>
      ) : (
        <Link
          href="/books"
          className="flex items-center gap-1 px-2 py-1 rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          title="Books"
          aria-label="Books"
        >
          <BookOpen className="h-3.5 w-3.5" />
        </Link>
      )}
      {!isHome && onSortChange && (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="flex items-center gap-1 px-2 py-1 rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <activeSortOption.Icon className="h-3.5 w-3.5" />
            <span style={{ fontSize: "11px", letterSpacing: "0.06em" }}>
              {activeSortOption.trigger}
            </span>
            <ChevronDown className="h-3 w-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {sortOptions.map(({ value, Icon, menu }) => (
            <DropdownMenuItem
              key={value}
              className="cursor-pointer"
              onClick={() => onSortChange(value)}
            >
              <Icon className="mr-2 h-4 w-4" />
              <span>{menu}</span>
              {sortDirection === value && <Check className="ml-auto h-4 w-4" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      )}
      <Link
        href="/settings/feeds"
        className="flex items-center gap-1 px-2 py-1 rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        title="Settings"
        aria-label="Settings"
      >
        <Settings className="h-3.5 w-3.5" />
      </Link>
    </div>
  )

  // Full-width search row between the icon toolbar and the filter chips (#283).
  const searchField = isHome ? null : (
    <SearchField
      value={searchQuery}
      onChange={onSearchQueryChange}
      placeholder={isBooks ? 'Search books' : isPile ? 'Search everything' : 'Search queue'}
      className="mb-2 lg:mb-0 lg:flex-1"
    />
  )

  // Desktop (#303): search + icon toolbar share one row at lg (search first,
  // stretching). DOM order stays toolbar-then-search so mobile is unchanged.
  const header = (
    <div className="lg:flex lg:items-center lg:gap-4 lg:mb-2">
      {toolbar}
      {searchField}
    </div>
  )
  const filterChips = isHome ? null : <FilterSummaryChips {...filterControlProps} />
  const addEntryDialog = !isBooks && (
    <AddEntryDialog open={isAddDialogOpen} onOpenChange={onAddDialogOpenChange} onAdded={onEntryAdded} />
  )

  if (items.length === 0) {
    return (
      <div className="mx-auto max-w-md p-4 lg:max-w-6xl">
        {header}
        {filterChips}
        <div className="pt-24 text-center">
          {/* With filters active the queue isn't empty — the filter just
              excludes everything — so don't claim "All caught up!". */}
          <h2 className="text-2xl font-bold text-foreground">{emptyState.heading}</h2>
          <p className="mt-2 text-muted-foreground">{emptyState.body}</p>
          {/* The SearchField's own × is "Clear search"; this one gets a distinct
              accessible name so the two stay separately addressable. */}
          {searchOnlyEmpty && (
            <Button
              variant="outline"
              className="mt-4 rounded-lg"
              aria-label="Clear search and show all items"
              onClick={() => onSearchQueryChange('')}
            >
              Clear search
            </Button>
          )}
        </div>
        {everythingLink}
        {addEntryDialog}
      </div>
    )
  }

  // Transform items for display (now with real multi-source data)
  const displayItems = items.map(transformToDisplayItem)
  const currentItem = displayItems[0]
  // Featured item's read/listen length estimate (#167); null when not computable.
  const currentLengthLabel = currentItem ? formatLength(currentItem) : null
  // Everything after the hero is a list card; the pile view has no hero
  // (#377). Nothing is hidden for lacking a queue position any more.
  const queueItems = isPile ? displayItems : displayItems.slice(1)
  const heroReason = reasons?.get(currentItem.id) ?? null

  const originalCurrentItem = items[0]
  // Hero ⋯ menu items, built once so the menu renders only when it has
  // something in it: without the Feedback item (#380) a book hero would
  // otherwise open an empty menu.
  const heroMenuItems = [
    // Resume the companion Spotify episode at the read position — #194
    getSpotifyResume(originalCurrentItem) && (
      <SpotifyResumeMenuItem key="spotify-resume" item={originalCurrentItem} hydrated={hydrated} />
    ),
    // Listen in ElevenReader (text feed items only) — #171
    onListen && canListenInReader(originalCurrentItem, isBooks) && (
      <ListenMenuItem key="listen" item={originalCurrentItem} onListen={onListen} />
    ),
    // Convert with Askwho Casts (text feed items only) — #226
    onConvert && canConvertWithAwc(originalCurrentItem, isBooks) && (
      <ConvertMenuItem key="convert" item={originalCurrentItem} onConvert={onConvert} onConvertManually={onConvertManually} />
    ),
    onConvert && canConvertCommentsWithAwc(originalCurrentItem, isBooks) && (
      <ConvertMenuItem key="convert-comments" item={originalCurrentItem} kind="comments" onConvert={onConvert} />
    ),
    onNotNow && <NotNowMenuItem key="not-now" item={originalCurrentItem} onNotNow={onNotNow} />,
  ].filter(Boolean)

  // Get primary and alternate sources for current item
  const primarySource = getPrimarySource(currentItem.sources)
  const primaryPlatform = getPrimaryPlatform(currentItem.sources)
  const primaryLink = getPrimaryLink(currentItem.sources)
  const startSource = heroStartSource(currentItem.sources, currentItem.status)
  const startPlatform = startSource?.platform ?? primaryPlatform
  const startLink = startSource?.link ?? ''
  const alternateSources = currentItem.sources.filter(s => s.id !== startSource?.id)
  // Computed over the item's FULL source list, not alternateSources: when the
  // primary itself is one of two Spotify episodes, the single Spotify left in
  // the alternate list would otherwise look unique and skip its label (#245).
  const heroRepeatedPlatforms = repeatedPlatforms(currentItem.sources)
  // START opens the Askwho Casts episode when there is one (#364), which goes to
  // Apple Podcasts on hydrated iOS (#236); everything else keeps the #197
  // treatment. href and label both come from startSource, so they stay coherent.
  const startTarget = sourceOpenTarget({ platform: startPlatform, link: startLink }, hydrated)

  const formatDate = (dateString: string | null) => {
    if (!dateString) return ""
    const date = new Date(dateString)
    // Books only have year-granularity publish dates (Goodreads gives a year,
    // stored as Jan 1), so show just the year rather than a misleading "1/1".
    // UTC year so a timezone offset can't roll it back to the prior year.
    if (isBooks) return String(date.getUTCFullYear())
    return date.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" })
  }

  // Build a map from display item id to original item for drag and drop
  // We need original items (not displayItems) because they have the queue positions
  const originalItemsMap = new Map<number, QueueItem>()
  items.forEach(item => originalItemsMap.set(item.id, item))

  // Draggable items: everything below the hero, books queue view only.
  const draggableItems = view === 'queue' ? items.slice(1) : []

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as number)
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    setActiveId(null)

    // Safety net: prevent reordering when any filter is active
    if (hasActiveFilters) return

    if (!over || active.id === over.id) return

    // Find indices in draggableItems array (using numeric IDs)
    const oldIndex = draggableItems.findIndex(item => item.id === active.id)
    const newIndex = draggableItems.findIndex(item => item.id === over.id)

    if (oldIndex === -1 || newIndex === -1) return

    // Reorder the items
    const reorderedItems = arrayMove(draggableItems, oldIndex, newIndex)

    // Call the onReorder callback with the reordered items and the moved item ID
    // The parent will handle optimistic update and API call
    onReorder?.(reorderedItems, active.id as number)
  }

  // Get the active item for DragOverlay
  const activeItem = activeId ? queueItems.find(item => item.id === activeId) : null

  return (
    <div className="mx-auto max-w-md p-4 lg:max-w-6xl">
      {header}
      {filterChips}

      {/* Desktop (#303): hero rail (sticky, scrolls internally when the
          summary expands it) beside the ranked list. Plain blocks below lg.
          overflow-y:auto also clips x, so a net-zero 4px gutter (-mx-1 px-1)
          keeps edge buttons' 3px focus rings visible. */}
      <div className={isPile ? "" : "lg:grid lg:grid-cols-[340px_minmax(0,1fr)] lg:gap-6 lg:items-start"}>
      {!isPile && (
      <section
        aria-label="Current item"
        className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto lg:-mx-1 lg:px-1 lg:pb-1"
      >
      {/* Current Item Header */}
      <div className="mb-6">
        {/* Option B (#167): featured cover floats top-right; title/author flow
            full-width on the left, matching the list cards. Books (#168) use the
            same placement with a portrait cover. */}
        <div className="float-right ml-4 mb-2">
          {/* Key by item id: the hero is the one un-keyed thumbnail slot, reused
              across every promoted item. Keying it forces a fresh <img> per book
              so a reused DOM node can't keep painting the previous cover (#168). */}
          <CardThumbnail
            key={currentItem.id}
            size="lg"
            imageUrl={currentItem.imageUrl}
            platform={getPrimaryPlatform(currentItem.sources)}
            title={currentItem.title}
            shape={isBooks ? "portrait" : "square"}
          />
        </div>
        <div className="flex items-center gap-3 flex-wrap mb-2">
          <h1 className="text-2xl font-medium lg:wrap-anywhere">{currentItem.title}</h1>
          {isStartedStatus(currentItem.status) && (
            <StatusBadge status={currentItem.status === AWAITING_COMMENTS ? "awaiting-comments" : "in-progress"} />
          )}
          {originalCurrentItem.sentToReaderAt != null && <SentToReaderBadge />}
          <AwcConversionBadge item={originalCurrentItem} agent={awcAgent} />
        </div>
        <div className="text-muted-foreground mb-3">{currentItem.author}</div>
        {heroReason && <PickReason text={heroReason} className="-mt-2 mb-3" />}
        {!isBooks && (
          <SummaryOneLiner
            summaryData={localCurrentSummary ? localCurrentSummary.summaryData : originalCurrentItem.summaryData}
            expanded={showCurrentItemSummary}
            className="-mt-2 mb-3"
          />
        )}
        {/* Progress bar — full width, cleared below the floated cover. */}
        {currentItem.progressPercent !== undefined && (
          <ProgressBar progress={currentItem.progressPercent} className="mt-4 clear-right" />
        )}
        <CommentsPrompt item={originalCurrentItem} onDone={onMarkComplete} />

        {/* Source / length / AI-summary row (#167) — pulled out of the text column
            to the card's left edge so it lines up with the action buttons below
            instead of sitting indented under the thumbnail. */}
        <div className="flex gap-2 mt-4 flex-wrap clear-right">
          {currentItem.sources.map((source) => (
            <span
              key={source.id}
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-secondary text-secondary-foreground"
              style={{ fontSize: "14px" }}
            >
              <SourceIcon platform={source.platform} className="w-4 h-4" />
              {source.platform}
            </span>
          ))}
          {currentItem.publishedOn && (
            <span
              className="inline-flex items-center px-3 py-1 rounded-full bg-secondary text-secondary-foreground"
              style={{ fontSize: "14px" }}
            >
              {formatDate(currentItem.publishedOn)}
            </span>
          )}
          {/* Read/listen length estimate (#167) — feed only, omitted when unknown. */}
          {!isBooks && currentLengthLabel && (
            <span
              className="inline-flex items-center px-3 py-1 rounded-full bg-secondary text-secondary-foreground"
              style={{ fontSize: "14px" }}
            >
              {currentLengthLabel}
            </span>
          )}
          {/* Sparkle toggle for AI Summary — books don't get AI summaries (#147) */}
          {!isBooks && (
            <button
              type="button"
              onClick={() => {
                if (!currentItemSummaryMounted) setCurrentItemSummaryMounted(true)
                setShowCurrentItemSummary(!showCurrentItemSummary)
              }}
              className="flex items-center justify-center w-10 h-10 rounded-full hover:bg-accent transition-colors"
              title={showCurrentItemSummary ? "Hide AI Summary" : "Show AI Summary"}
            >
              <Sparkles className={`h-5 w-5 ${(localCurrentSummary?.summary ?? originalCurrentItem.summary) ? "text-primary fill-primary" : "text-muted-foreground"}`} />
            </button>
          )}
        </div>
      </div>

      {/* Action Buttons */}
      <div className="mb-8 space-y-2 lg:mb-0">
        {/* Resume Button with dropdown for multiple sources */}
        <div className="flex gap-2">
          {/* Real anchor when there's an http link so iOS can hand Substack
              (and other) URLs off to the native app — see lib/links.ts (#197).
              Link-less items (physical books) keep a plain button that only
              marks the item In Progress. */}
          {startLink.startsWith('http') ? (
            <Button
              asChild
              className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90 rounded-xl h-12 font-medium"
            >
              <a
                href={startTarget.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => onStartItem(originalCurrentItem)}
              >
                {isStartedStatus(currentItem.status) ? "RESUME" : "START"}
                {startTarget.applePodcasts
                  ? " IN APPLE PODCASTS"
                  : currentItem.sources.length > 1
                    ? ` ON ${startPlatform.toUpperCase()}`
                    : ""}
              </a>
            </Button>
          ) : (
            <Button
              onClick={() => onStartItem(originalCurrentItem)}
              className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90 rounded-xl h-12 font-medium"
            >
              {isStartedStatus(currentItem.status) ? "RESUME" : "START"}
              {currentItem.sources.length > 1 ? ` ON ${startPlatform.toUpperCase()}` : ""}
            </Button>
          )}
          {alternateSources.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="rounded-xl h-12 w-12 p-0 border border-border bg-card hover:bg-accent flex items-center justify-center">
                  <MoreHorizontal className="h-5 w-5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {alternateSources.map((source) => {
                  const link = source.link ?? ''
                  // Real anchor for the same universal-link reason as the
                  // primary START control (#197).
                  if (link) {
                    // AWC sources swap to Apple Podcasts on hydrated iOS (#236).
                    const target = sourceOpenTarget(
                      source,
                      hydrated,
                      heroRepeatedPlatforms.has(source.platform),
                    )
                    return (
                      <DropdownMenuItem key={source.id} asChild className="cursor-pointer">
                        <a
                          href={target.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={sourceMenuItemAriaLabel(target)}
                          onClick={() => onStartItem(originalCurrentItem)}
                        >
                          <SourceMenuItemContent platform={source.platform} target={target} />
                        </a>
                      </DropdownMenuItem>
                    )
                  }
                  return (
                    <DropdownMenuItem key={source.id} disabled>
                      <SourceIcon platform={source.platform} className="mr-2 h-4 w-4" />
                      <span>{source.platform}</span>
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {/* Complete, Skip, and More */}
        <div className="flex gap-2">
          <Button
            onClick={() => onMarkComplete(originalCurrentItem)}
            variant="outline"
            className="flex-1 rounded-xl h-12 border-border font-medium"
          >
            <Check className="mr-2 h-4 w-4" />
            Complete
          </Button>
          <Button
            onClick={() => onSkip(originalCurrentItem)}
            variant="outline"
            className="flex-1 rounded-xl h-12 border-border font-medium"
          >
            <SkipForward className="mr-2 h-4 w-4" />
            Skip
          </Button>
          {heroMenuItems.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button aria-label="More actions" className="rounded-xl h-12 w-12 p-0 border border-border bg-card hover:bg-accent flex items-center justify-center">
                <MoreHorizontal className="h-5 w-5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {heroMenuItems}
            </DropdownMenuContent>
          </DropdownMenu>
          )}
        </div>

        {!isBooks && currentItemSummaryMounted && (
          <div className={showCurrentItemSummary ? "" : "hidden"}>
            <SummarySection
              contentItemId={originalCurrentItem.id}
              summary={localCurrentSummary?.summary ?? originalCurrentItem.summary}
              summaryGeneratedAt={localCurrentSummary?.generatedAt ?? originalCurrentItem.summaryGeneratedAt}
              itemTitle={currentItem.title}
              itemLink={primaryLink}
              summaryData={localCurrentSummary ? localCurrentSummary.summaryData : originalCurrentItem.summaryData}
              onSummaryGenerated={(summary, generatedAt, summaryData) => setLocalCurrentSummary({ summary, generatedAt, summaryData })}
            />
          </div>
        )}
      </div>
      </section>
      )}

      <div className="min-w-0">
      {/* Queue Items List with Drag and Drop */}
      <DndContext
        id="queue-dnd"
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={queueItems.map(item => item.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-2">
            {queueItems.map((item) => {
              const originalItem = originalItemsMap.get(item.id)
              if (!originalItem) return null

              return (
                <SortableQueueItem
                  key={item.id}
                  item={item}
                  originalItem={originalItem}
                  draggable={view === 'queue'}
                  sortDirection={sortDirection}
                  filtersActive={hasActiveFilters}
                  onMakeNext={onMakeNext}
                  onMarkComplete={onMarkComplete}
                  onSkip={onSkip}
                  onToggleStarted={onToggleStarted}
                  onListen={onListen}
                  onConvert={onConvert}
                  onConvertManually={onConvertManually}
                  onNotNow={isHome || (isPile && pickIds?.has(item.id)) ? onNotNow : undefined}
                  reason={reasons?.get(item.id) ?? null}
                  isPick={isPile && (pickIds?.has(item.id) ?? false)}
                  isNew={isPile && (newIds?.has(item.id) ?? false)}
                  awcAgent={awcAgent}
                  formatDate={formatDate}
                  isBooks={isBooks}
                />
              )
            })}
          </div>
        </SortableContext>
        <DragOverlay>
          {activeItem && (
            <QueueItemCard item={activeItem} formatDate={formatDate} isBooks={isBooks} />
          )}
        </DragOverlay>
      </DndContext>
      {everythingLink}
      </div>
      </div>

      {/* Feed pages use the AddEntryDialog; the books page renders its own
          AddBookDialog from BooksClient via the same dialog state, so we
          skip mounting AddEntryDialog when kind='book'. */}
      {addEntryDialog}
    </div>
  )
})
