import { isStartedStatus } from './content-status'
import { fetchWithRetry } from './fetch-with-retry'
import { recommendedSort } from './recommended-sort'
import { summaryDataFromDb, type SummaryData } from './summary-data'
import type { Curation } from './shortlist'
import { latestConversionSummary, type AwcConversionDB, type AwcConversionSummary, type AwcKind } from './awc/stages'

// =============================================================================
// Database Types (snake_case - matches Supabase schema)
// =============================================================================

// Discriminator added by #147 (Books mode). DB column defaults to 'feed' for
// rows written before the migration, so the field is required at the type
// level but kept optional in the snake-case DB interfaces to keep test
// fixtures and any legacy callers working (dbToApp defaults to 'feed').
export type ContentKind = 'feed' | 'book'

// Content item from content_items table
export interface ContentItemDB {
  id: number
  title: string
  author: string
  published_on: string | null
  status: string
  queue_position: number | null
  position_confirmed: boolean
  progress: string | null
  added_by: string | null
  created_at: string
  updated_at: string
  status_changed_at: string | null
  summary?: string | null
  summary_generated_at?: string | null
  // Structured summary (#304): { one_liner, bullets, source_access, model, version }.
  // unknown on purpose: validated by summaryDataFromDb at the boundary.
  summary_data?: unknown
  kind?: ContentKind
  // When the item was last sent to ElevenReader (#171). NULL = never sent.
  sent_to_reader_at?: string | null
  // Feed-card enrichment (#167). Optional in the DB interface so existing
  // fixtures/rows without the columns still type-check (dbToApp defaults to null).
  image_url?: string | null
  word_count?: number | null
  duration_seconds?: number | null
  // Book metadata (#186), set by the agentic add; INSERT-only. Optional so rows
  // predating the migration still type-check. Not yet surfaced in the UI (book
  // cover display is #168); persisted here for that follow-up work.
  isbn13?: string | null
  subtitle?: string | null
  series?: string | null
  // The owner's overrides for the home shortlist (#377): "Make next" and "Not now".
  // Optional so older fixtures type-check; dbToApp defaults both to null.
  pinned_at?: string | null
  shortlist_dismissed_at?: string | null
}

// Source from content_sources table. `link` is nullable as of #147 so a
// "Physical" book source can exist without a URL.
export interface ContentSourceDB {
  id: number
  content_item_id: number
  platform: string
  link: string | null
  message_id: string | null
  is_primary: boolean
  created_at: string
  // Cross-platform identity, e.g. 'spotify:episode:<id>' (#194 resume link).
  // Optional so older payload shapes / fixtures stay valid.
  external_id?: string | null
  // Per-source progress percent (#194): the platform's own last-seen position,
  // NOT the item-level high-water mark. Optional so older fixtures stay valid.
  progress?: number | null
  // Human-readable name of the specific source within the platform, e.g. the
  // Spotify show name (#245). Null for legacy rows and platforms that don't set it.
  source_label: string | null
}

// Content item with joined sources (from Supabase query)
export interface ContentItemWithSourcesDB extends ContentItemDB {
  sources: ContentSourceDB[]
  // Askwho Casts conversion requests (#317), embedded by the queue fetch only.
  awc_conversions?: AwcConversionDB[]
}

// Legacy type alias for backwards compatibility
export type QueueItemDB = ContentItemDB & {
  platform: string
  link: string | null
  message_id: string | null
}

// =============================================================================
// Application Types (camelCase - used in UI)
// =============================================================================

// Source in application format. `link` is nullable for Physical/Library/Other
// formats that have no URL (#147).
export interface ContentSource {
  id: number
  platform: string
  link: string | null
  messageId: string | null
  isPrimary: boolean
  createdAt: string
  // e.g. 'spotify:episode:<id>' — feeds the Resume-on-Spotify link (#194)
  externalId?: string | null
  // Platform's own last-seen position percent (#194) — feeds the resume gate.
  progress?: number | null
  // Spotify show name (or other per-source label); disambiguates same-platform
  // sources in the source menus (#245). Null when the row carries no label.
  sourceLabel: string | null
}

// Content item with sources array
export interface QueueItem {
  id: number
  title: string
  author: string
  publishedOn: string | null
  status: string
  queuePosition: number | null
  positionConfirmed: boolean
  progress: string | null
  addedBy: string | null
  createdAt: string
  updatedAt: string
  statusChangedAt: string | null
  summary?: string | null
  summaryGeneratedAt?: string | null
  // Structured summary (#304). null = legacy text-only summary (or none).
  summaryData?: SummaryData | null
  kind: ContentKind
  // When the item was last sent to ElevenReader (#171). null = never sent.
  sentToReaderAt: string | null
  // Feed-card enrichment (#167): preview thumbnail + raw read/listen length signals.
  imageUrl: string | null
  wordCount: number | null
  durationSeconds: number | null
  // Author engagement (#255): derived server-side from the
  // author_engagement_scores view (-1..1) and attached to queue responses.
  // Absent on mock data and POST responses; never persisted (appToDb omits it).
  engagementScore?: number | null
  // Latest Askwho Casts conversion request (#317): active or failed; null
  // otherwise. Optional so older fixtures and non-queue payloads stay valid.
  awcConversion?: AwcConversionSummary | null
  // Home shortlist overrides (#377). pinnedAt = "Make next" (top of home,
  // newest first); shortlistDismissedAt = "Not now" (off home for the
  // dismiss hold). Optional so older fixtures stay valid; dbToApp sets both.
  pinnedAt?: string | null
  shortlistDismissedAt?: string | null
  // Multi-source support
  sources: ContentSource[]
  // Convenience accessors derived from the primary source. `link` is coerced
  // to '' here when the primary source has none, so legacy UI code that
  // expects a string keeps working — components that need to distinguish
  // "no URL" from "empty URL" should iterate `sources` directly.
  platform: string
  link: string
}

// Convert source from database to application format
function sourceDbToApp(source: ContentSourceDB): ContentSource {
  return {
    id: source.id,
    platform: source.platform,
    link: source.link,
    messageId: source.message_id,
    isPrimary: source.is_primary,
    createdAt: source.created_at,
    externalId: source.external_id ?? null,
    progress: source.progress ?? null,
    sourceLabel: source.source_label ?? null,
  }
}

// Get primary source from sources array (by is_primary flag or first source)
function getPrimarySource(sources: ContentSource[]): ContentSource | null {
  if (!sources || sources.length === 0) return null
  return sources.find(s => s.isPrimary) || sources[0]
}

// Convert database record (snake_case) to application object (camelCase)
// Supports both new multi-source format and legacy single-source format
export function dbToApp(item: ContentItemWithSourcesDB | QueueItemDB): QueueItem {
  // Handle new multi-source format
  if ('sources' in item && Array.isArray(item.sources)) {
    const sources = item.sources.map(sourceDbToApp)
    const primary = getPrimarySource(sources)

    return {
      id: item.id,
      title: item.title,
      author: item.author,
      publishedOn: item.published_on,
      status: item.status,
      queuePosition: item.queue_position,
      positionConfirmed: item.position_confirmed,
      progress: item.progress,
      addedBy: item.added_by,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      statusChangedAt: item.status_changed_at,
      summary: item.summary,
      summaryGeneratedAt: item.summary_generated_at,
      summaryData: summaryDataFromDb(item.summary_data),
      kind: item.kind ?? 'feed',
      sentToReaderAt: item.sent_to_reader_at ?? null,
      imageUrl: item.image_url ?? null,
      wordCount: item.word_count ?? null,
      durationSeconds: item.duration_seconds ?? null,
      awcConversion: latestConversionSummary(item.awc_conversions),
      pinnedAt: item.pinned_at ?? null,
      shortlistDismissedAt: item.shortlist_dismissed_at ?? null,
      sources,
      // Convenience fields from primary source
      platform: primary?.platform || '',
      link: primary?.link || '',
    }
  }

  // Handle legacy single-source format (backwards compatibility)
  const legacyItem = item as QueueItemDB
  return {
    id: legacyItem.id,
    title: legacyItem.title,
    author: legacyItem.author,
    publishedOn: legacyItem.published_on,
    status: legacyItem.status,
    queuePosition: legacyItem.queue_position,
    positionConfirmed: legacyItem.position_confirmed,
    progress: legacyItem.progress,
    addedBy: null,
    createdAt: legacyItem.created_at,
    updatedAt: legacyItem.updated_at,
    statusChangedAt: legacyItem.status_changed_at,
    summary: legacyItem.summary,
    summaryGeneratedAt: legacyItem.summary_generated_at,
    summaryData: summaryDataFromDb(legacyItem.summary_data),
    kind: legacyItem.kind ?? 'feed',
    sentToReaderAt: legacyItem.sent_to_reader_at ?? null,
    imageUrl: legacyItem.image_url ?? null,
    wordCount: legacyItem.word_count ?? null,
    durationSeconds: legacyItem.duration_seconds ?? null,
    awcConversion: null,
    pinnedAt: legacyItem.pinned_at ?? null,
    shortlistDismissedAt: legacyItem.shortlist_dismissed_at ?? null,
    // Create single-source array from legacy fields
    sources: [{
      id: legacyItem.id,
      platform: legacyItem.platform,
      link: legacyItem.link,
      messageId: legacyItem.message_id,
      isPrimary: true,
      createdAt: legacyItem.created_at,
      externalId: null,
      progress: null,
      sourceLabel: null,
    }],
    platform: legacyItem.platform,
    link: legacyItem.link || '',
  }
}

// Convert application object (camelCase) to database record (snake_case)
// Supports partial updates for content_items table. `kind` and the feed-card
// enrichment fields (imageUrl / wordCount / durationSeconds, #167) are
// intentionally NOT emitted here — they are set on INSERT (via the
// insert_or_update_content RPC) and never updated afterwards, so even a caller
// that passes them in a partial update payload won't accidentally rewrite a row.
// Note: platform, link, message_id are now in content_sources table.
export function appToDb(item: Partial<QueueItem>): Partial<ContentItemDB> {
  const result: Partial<ContentItemDB> = {}

  if (item.id !== undefined) result.id = item.id
  if (item.title !== undefined) result.title = item.title
  if (item.author !== undefined) result.author = item.author
  if (item.publishedOn !== undefined) result.published_on = item.publishedOn
  if (item.status !== undefined) result.status = item.status
  if (item.queuePosition !== undefined) result.queue_position = item.queuePosition
  if (item.positionConfirmed !== undefined) result.position_confirmed = item.positionConfirmed
  if (item.progress !== undefined) result.progress = item.progress
  if (item.createdAt !== undefined) result.created_at = item.createdAt
  if (item.updatedAt !== undefined) result.updated_at = item.updatedAt

  return result
}

// Parse an error response body for a server-provided message, falling back to a generic message
async function throwApiError(response: Response, fallbackMessage: string): Promise<never> {
  let message = fallbackMessage
  try {
    const body = await response.json()
    if (body.error) message = body.error
  } catch {
    // response body not parseable — use fallback
  }
  throw new Error(message)
}

// Internal: pick the active and archive API paths for a given content kind.
// Books mode (#147) reuses the queue UI against /api/books and /api/books/archive;
// every existing caller defaults to 'feed' so this is a no-op for them.
function apiPaths(kind: ContentKind): { active: string; archive: string } {
  return kind === 'book'
    ? { active: '/api/books', archive: '/api/books/archive' }
    : { active: '/api/queue', archive: '/api/archive' }
}

// Fetch active items (queue for feed, books queue for books).
export async function fetchQueueData(kind: ContentKind = 'feed'): Promise<QueueItem[]> {
  const response = await fetchWithRetry(apiPaths(kind).active, { cache: 'no-store' })

  if (!response.ok) {
    await throwApiError(response, 'Failed to fetch queue data')
  }

  const data = await response.json()
  // The feed route answers { items, curation } since #377.
  return parseQueueData(Array.isArray(data) ? data : (data?.items ?? []))
}

// The feed home and /everything (#377): every active feed item plus the latest
// curator run. GET /api/queue returns this envelope; /api/books stays an array.
export interface FeedHomeData {
  items: QueueItem[]
  curation: Curation | null
}

export async function fetchFeedHome(): Promise<FeedHomeData> {
  const response = await fetchWithRetry(apiPaths('feed').active, { cache: 'no-store' })
  if (!response.ok) {
    await throwApiError(response, 'Failed to fetch queue data')
  }
  const data = await response.json()
  // Tolerate the pre-#377 array shape (deploy skew) rather than crash.
  if (Array.isArray(data)) return { items: data as QueueItem[], curation: null }
  return { items: Array.isArray(data?.items) ? data.items : [], curation: data?.curation ?? null }
}

// #377: Make next on the feed. Server-side single-row write on an active item.
export async function pinItem(id: number): Promise<void> {
  const response = await fetchWithRetry(apiPaths('feed').active, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'pin', id }),
  })
  if (!response.ok) {
    await throwApiError(response, 'Failed to pin item')
  }
}

// #377: Not now. Sends the item back to the pile for the dismiss hold.
export async function dismissItem(id: number): Promise<void> {
  const response = await fetchWithRetry(apiPaths('feed').active, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'dismiss', id }),
  })
  if (!response.ok) {
    await throwApiError(response, 'Failed to move item off the shortlist')
  }
}

// The Everything page's sort (#377): publish date only, no legacy queue
// position pinned on top. publishedOn || createdAt, ties by higher id.
export function sortByPublished(items: QueueItem[], direction: 'newest' | 'oldest'): QueueItem[] {
  const sign = direction === 'newest' ? -1 : 1
  const time = (item: QueueItem) => Date.parse(item.publishedOn || item.createdAt) || 0
  return [...items].sort((a, b) => sign * (time(a) - time(b)) || b.id - a.id)
}

// Sort direction type
// - 'queue': Default queue order (position first, then status, then date)
// - 'newest': Sort by published date, newest first
// - 'oldest': Sort by published date, oldest first
// - 'recommended': Scored ranking (in-progress, recency, engagement,
//   diversity — #255) via lib/recommended-sort.ts
const SORT_DIRECTIONS = ['queue', 'newest', 'oldest', 'recommended'] as const
export type SortDirection = (typeof SORT_DIRECTIONS)[number]

// Type guard for values read from storage (localStorage validity checks).
export function isSortDirection(value: string | null): value is SortDirection {
  return (SORT_DIRECTIONS as readonly string[]).includes(value ?? '')
}

// Parse and sort queue data
// Note: Filtering is done server-side in the API route
export function parseQueueData(items: QueueItem[], sortDirection: SortDirection = 'queue'): QueueItem[] {
  if (!items || items.length === 0) return []

  // Scored ranking (#255): pin the #1 queue item at top exactly as the date
  // sorts do, then score everything below it. Keeping the pin is what makes
  // "Make it next" visibly do something in this mode — without it the tapped
  // card often didn't move even though the queue had been renumbered.
  // Same IDENTITY-based exclusion as the date branch (see the #229 note below).
  if (sortDirection === 'recommended') {
    const pinned = items.find(item => item.queuePosition === 1)
    const rest = recommendedSort(items.filter(item => item !== pinned))
    return pinned ? [pinned, ...rest] : rest
  }

  // For 'queue' order: respect queue_position first
  if (sortDirection === 'queue') {
    return items.sort((a, b) => {
      // Items with queue_position set come first (manual ordering)
      if (a.queuePosition !== null && b.queuePosition === null) return -1
      if (a.queuePosition === null && b.queuePosition !== null) return 1
      if (a.queuePosition !== null && b.queuePosition !== null) {
        return a.queuePosition - b.queuePosition
      }

      // For items without manual position: status first (In Progress), then by date
      if (isStartedStatus(a.status) && !isStartedStatus(b.status)) return -1
      if (!isStartedStatus(a.status) && isStartedStatus(b.status)) return 1

      const aDate = a.publishedOn || a.createdAt
      const bDate = b.publishedOn || b.createdAt
      return new Date(bDate).getTime() - new Date(aDate).getTime() // newest first
    })
  }

  // For 'newest' or 'oldest': Hybrid sort - pin the #1 queue item at top, rest sorted by date.
  // Exclude the pinned item by IDENTITY, not by position value: if data corruption ever
  // produces several items at position 1, filtering on the value silently dropped all the
  // others from the returned array — which is also the client's state, so later Make
  // Next/reorder batches never renumbered them and the corruption self-perpetuated (#229).
  const topItem = items.find(item => item.queuePosition === 1)
  const remainingItems = items.filter(item => item !== topItem)
  const sortMultiplier = sortDirection === 'newest' ? -1 : 1

  remainingItems.sort((a, b) => {
    const aDate = a.publishedOn || a.createdAt
    const bDate = b.publishedOn || b.createdAt
    return sortMultiplier * (new Date(aDate).getTime() - new Date(bDate).getTime())
  })

  if (topItem) {
    return [topItem, ...remainingItems]
  }
  return remainingItems
}

// Update item status
export async function updateItemStatus(id: number, status: string, kind: ContentKind = 'feed'): Promise<void> {
  const response = await fetchWithRetry(apiPaths(kind).active, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'updateStatus', id, status }),
  })

  if (!response.ok) {
    await throwApiError(response, 'Failed to update status')
  }
}

// Promote an item to position 1. Server-side atomic shift (#229) — never
// send a client-computed renumber batch for this; a stale client snapshot
// mints duplicate positions.
export async function makeItemNext(id: number, kind: ContentKind = 'feed'): Promise<void> {
  const response = await fetchWithRetry(apiPaths(kind).active, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'makeNext', id }),
  })

  if (!response.ok) {
    await throwApiError(response, 'Failed to promote item')
  }
}

// Update item progress (new function)
export async function updateItemProgress(id: number, progress: string, kind: ContentKind = 'feed'): Promise<void> {
  const response = await fetchWithRetry(apiPaths(kind).active, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'updateProgress', id, progress }),
  })

  if (!response.ok) {
    await throwApiError(response, 'Failed to update progress')
  }
}

// Update position confirmation status
export async function updatePositionConfirmed(id: number, positionConfirmed: boolean, kind: ContentKind = 'feed'): Promise<void> {
  const response = await fetchWithRetry(apiPaths(kind).active, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'updatePositionConfirmed', id, positionConfirmed }),
  })

  if (!response.ok) {
    await throwApiError(response, 'Failed to update position confirmation')
  }
}

// Mark an item as sent to ElevenReader (#171). Sets sent_to_reader_at server-side.
export async function markSentToReader(id: number, kind: ContentKind = 'feed'): Promise<void> {
  const response = await fetchWithRetry(apiPaths(kind).active, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'markSentToReader', id }),
  })

  if (!response.ok) {
    await throwApiError(response, 'Failed to mark item as sent to ElevenReader')
  }
}

// #317: ask the Mac agent to convert this item with Askwho Casts. Not retried:
// a retry after a lost response would 409 against the row it just created.
// On 409 a conversion is already active (another tab/device): returns that
// row (null if it finished in between) with alreadyActive set.
export async function requestAwcConversion(
  id: number,
  kind: AwcKind = 'article',
): Promise<{ conversion: AwcConversionSummary | null; alreadyActive: boolean }> {
  const response = await fetch(apiPaths('feed').active, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'requestAwcConversion', id, ...(kind === 'comments' ? { kind } : {}) }),
  })

  if (response.status === 409) {
    const body = (await response.json().catch(() => ({}))) as { conversion?: AwcConversionSummary | null }
    return { conversion: body.conversion ?? null, alreadyActive: true }
  }
  if (!response.ok) {
    await throwApiError(response, 'Failed to send to Askwho Casts agent')
  }
  return { conversion: (await response.json()) as AwcConversionSummary, alreadyActive: false }
}

// Restore a completed/skipped item back to the queue
// Sets status to '' and places it at rank 2 (right behind the top item),
// unconfirmed
export async function restoreItem(id: number, kind: ContentKind = 'feed'): Promise<void> {
  // restoreItem is non-idempotent (shifts positions + inserts) — do not retry
  const response = await fetchWithRetry(apiPaths(kind).active, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'restoreItem', id }),
  }, { retries: 0 })

  if (!response.ok) {
    await throwApiError(response, 'Failed to restore item')
  }
}

// Fetch archived items (completed/skipped)
export async function fetchArchivedItems(kind: ContentKind = 'feed'): Promise<QueueItem[]> {
  const response = await fetchWithRetry(apiPaths(kind).archive)

  if (!response.ok) {
    await throwApiError(response, 'Failed to fetch archived items')
  }

  return response.json()
}

// Batch update interface for type safety
export interface QueueItemUpdate {
  id: number
  status?: string
  queuePosition?: number | null
  positionConfirmed?: boolean
}

// Batch update multiple queue items in a single request
// This dramatically reduces the number of database round-trips
// Example: Updating 15 items goes from 15 requests to 1 request (~95% faster)
export async function batchUpdateQueue(updates: QueueItemUpdate[], kind: ContentKind = 'feed'): Promise<void> {
  const response = await fetchWithRetry(apiPaths(kind).active, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'batchUpdate', updates }),
  })

  if (!response.ok) {
    await throwApiError(response, 'Failed to batch update queue items')
  }
}

