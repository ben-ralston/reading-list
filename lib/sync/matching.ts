/**
 * Content matching logic for sync operations
 *
 * Matches incoming sync items to existing content in the database using a
 * four-strategy cascade (see findMatchingContent for details):
 * 1. External ID match (exact, platform-specific)
 * 2. Normalized title + author match (alias-aware, exact)
 * 3. Fuzzy title match with ambiguity guard (alias-aware)
 * 4. Link-based match on content_sources (escape hatch)
 */

import { AWAITING_COMMENTS } from '@/lib/content-status'
import { SupabaseClient } from '@supabase/supabase-js'
import { insertAtSmartPosition } from '@/lib/scoring/queue-position'
import { getAuthorAliases } from '@/lib/scoring/engagement'
import { normalizeTitle, fuzzyTitleScore, baseTitle } from '@/lib/sync/normalize-title'
import { serializeError } from '@/lib/sync/serialize-error'
import { redactFeedSecret, isAskwhocastsUrl } from '@/lib/sync/redact'

/**
 * Sync item from external platform
 */
export interface SyncItem {
  title: string
  author: string
  platform: string
  link?: string | null
  progress?: string
  status?: 'In Progress' | 'Completed'
  externalId?: string
  publishedOn?: string // ISO date string (YYYY-MM-DD)
  manuallyRequested?: boolean
  /**
   * Content kind: 'feed' (default — newsletters/RSS/podcasts) or 'book' (books mode, #147).
   * Applied only on INSERT via insert_or_update_content; existing items'
   * kind is never overwritten.
   */
  kind?: 'feed' | 'book'
  /**
   * For 'Completed' Goodreads imports etc. — the date the user finished
   * the item. Forwarded to content_items.status_changed_at on insert via
   * the API route, not via this matching layer directly.
   */
  statusChangedAt?: string
  /**
   * Feed-card enrichment (#167), applied only on INSERT via
   * insert_or_update_content. imageUrl is a preview thumbnail; wordCount /
   * durationSeconds are the raw read/listen length signals.
   */
  imageUrl?: string | null
  wordCount?: number | null
  durationSeconds?: number | null
  /**
   * Book metadata from the agentic add (#186), applied only on INSERT via
   * upsert_content_item (INSERT-only, like the feed-card enrichment above).
   * isbn13 is stored as text to preserve leading zeros / an 'X' check digit.
   */
  isbn13?: string | null
  subtitle?: string | null
  series?: string | null
  /**
   * Spotify saved-episode `added_at` (#305). Read only by the sync's
   * back-catalog guard (lib/spotify/back-catalog.ts); never persisted.
   */
  savedAt?: string
}

/**
 * Valid sync sources
 */
export type SyncSource = 'spotify' | 'audible' | 'substack' | 'elevenreader' | 'tasklet' | 'rss' | 'goodreads' | 'apple_podcasts'

/**
 * Match result indicating what action to take
 */
export interface MatchResult {
  contentItemId: number
  sourceId?: number
  sourceLabel?: string | null
  action: 'update'
}

/**
 * Exact content_sources.external_id lookup — Strategy 1 of findMatchingContent,
 * exported for sources that must match by ID only (Apple Podcasts, #322: a
 * title/link fallback could attach a listen to the wrong item).
 */
export async function findByExternalId(
  externalId: string | undefined,
  supabase: SupabaseClient
): Promise<MatchResult | null> {
  if (!externalId) return null
  const { data: sourceMatch, error: sourceError } = await supabase
    .from('content_sources')
    .select('id, content_item_id, source_label')
    .eq('external_id', externalId)
    .maybeSingle()

  if (sourceError) {
    console.error('[Sync Matching] Error querying by external_id:', sourceError)
    throw sourceError
  }

  return sourceMatch
    ? { contentItemId: sourceMatch.content_item_id, sourceId: sourceMatch.id, sourceLabel: sourceMatch.source_label, action: 'update' }
    : null
}

/**
 * Find matching content for a sync item
 *
 * @param item - Sync item from external platform
 * @param supabase - Supabase client instance
 * @returns Match result if found, null if no match
 *
 * Matching strategy:
 * 1. If externalId is provided, try exact match in content_sources (cross-kind:
 *    external IDs are namespaced like 'goodreads:book:N' / 'spotify:episode:N',
 *    so a collision can only mean the right row).
 * 2. Fall back to case-insensitive title + author match in content_items
 *    (kind-scoped to avoid attaching a book CSV row to a same-titled feed item).
 * 3. Fall back to title + author alias match (kind-scoped).
 * 4. If item has a link, fall back to matching by content_sources.link
 *    (kind-scoped via inner join on content_items.kind).
 */
export async function findMatchingContent(
  item: SyncItem,
  supabase: SupabaseClient
): Promise<MatchResult | null> {
  const kind = item.kind ?? 'feed'

  // Strategy 1: Try external_id match first (cross-kind by design).
  const byExternalId = await findByExternalId(item.externalId, supabase)
  if (byExternalId) return byExternalId

  // Strategy 2 & 3: Normalized title + author match (including aliases).
  // Kind-scoped: only candidates of the same kind are considered, so a
  // Goodreads CSV row that title+author-matches a feed item by the same
  // name won't attach a Goodreads source to the feed item (#147).
  // Skipped when the incoming title normalizes to empty — in that case
  // Strategy 4 (link-based) is the only option left.
  const candidates = await fetchAuthorCandidates(item.author, kind, supabase)
  const incomingNormalized = normalizeTitle(item.title, item.author)

  if (incomingNormalized !== '') {
    const normalized = candidates.map((c) => ({
      id: c.id,
      normalizedTitle: normalizeTitle(c.title, c.author),
    })).filter(({ normalizedTitle }) => normalizedTitle !== '')

    // First pass: exact normalized match
    for (const { id, normalizedTitle } of normalized) {
      if (normalizedTitle === incomingNormalized) {
        return { contentItemId: id, action: 'update' }
      }
    }

    // Second pass: fuzzy match with ambiguity check. An ambiguous fuzzy result
    // falls through to Strategy 4 rather than returning null — the link, if
    // present, is a more definitive signal than two near-tied titles.
    const scored = normalized
      .map(({ id, normalizedTitle }) => ({
        id,
        score: fuzzyTitleScore(incomingNormalized, normalizedTitle),
      }))
      .filter((entry): entry is { id: number; score: number } => entry.score !== null)
      .sort((a, b) => b.score - a.score || a.id - b.id)

    if (scored.length > 0) {
      const unambiguous =
        scored.length === 1 || scored[0].score - scored[1].score >= AMBIGUITY_MARGIN
      if (unambiguous) {
        return { contentItemId: scored[0].id, action: 'update' }
      }
      // else: fall through to Strategy 4
    }

    // Strategy 3.5 (books only): base-title match. Audible sends base titles
    // while Goodreads stores full titles with a ": subtitle" or " (Series, #N)"
    // suffix, so the exact and fuzzy passes miss them and a duplicate book is
    // created (#42). Strip both sides to a base title and accept only an
    // unambiguous single match. Kept book-scoped so battle-tested feed matching
    // (exact / fuzzy / link) is untouched; the author + kind candidate pool and
    // the single-match guard keep it from collapsing genuinely distinct works
    // (e.g. "Dune: Part One" vs "Dune: Part Two").
    if (kind === 'book') {
      const incomingBase = baseTitle(incomingNormalized)
      if (incomingBase !== '') {
        const baseMatches = normalized.filter(
          ({ normalizedTitle }) => baseTitle(normalizedTitle) === incomingBase
        )
        if (baseMatches.length === 1) {
          return { contentItemId: baseMatches[0].id, action: 'update' }
        }
      }
    }
  }

  // Strategy 4: link-based match (escape hatch when titles diverge, are
  // ambiguous, or normalize to empty). Kind-scoped via inner join on
  // content_items so a book's Goodreads link can't surface a feed source
  // (and vice versa). Trim once so whitespace variants in the incoming
  // link still match the stored (trimmed) value.
  const trimmedLink = item.link?.trim()
  if (trimmedLink) {
    const { data: linkMatches, error: linkError } = await supabase
      .from('content_sources')
      .select('id, content_item_id, content_items!inner(kind)')
      .eq('link', trimmedLink)
      .eq('content_items.kind', kind)
      .limit(1)

    if (linkError) {
      console.error('[Sync Matching] Error querying by link:', linkError)
      throw linkError
    }

    if (linkMatches && linkMatches.length > 0) {
      return {
        contentItemId: linkMatches[0].content_item_id,
        sourceId: linkMatches[0].id,
        action: 'update',
      }
    }
  }

  // No match found
  return null
}

/** Minimum score difference to accept a fuzzy match over the runner-up */
const AMBIGUITY_MARGIN = 0.02

interface ContentCandidate {
  id: number
  title: string
  author: string
}

/**
 * Fetch all content items for an author and their aliases in a single pass.
 * Deduplicates by item ID. Kind-scoped so feed and book matching pools stay
 * independent (#147) — pass 'feed' (default) or 'book'.
 */
export async function fetchAuthorCandidates(
  author: string,
  kind: 'feed' | 'book',
  supabase: SupabaseClient
): Promise<ContentCandidate[]> {
  const aliases = await getAuthorAliases(author.trim(), supabase)
  const authorSet = new Set([author.trim().toLowerCase(), ...aliases])

  const candidates = new Map<number, ContentCandidate>()

  for (const alias of authorSet) {
    const { data, error } = await supabase
      .from('content_items')
      .select('id, title, author')
      .eq('kind', kind)
      .ilike('author', alias)

    if (error) {
      console.error('[Sync Matching] Error querying by author:', error)
      throw error
    }

    for (const row of (data || []) as ContentCandidate[]) {
      if (!candidates.has(row.id)) {
        candidates.set(row.id, row)
      }
    }
  }

  return Array.from(candidates.values())
}

/**
 * Determine whether to auto-add content that wasn't found
 *
 * @param source - Sync source platform
 * @returns Whether to auto-create content for this source
 *
 * Most sources auto-add with position_confirmed=false (shown as suggestions).
 * 'substack' is update-only: the progress harvester reads the ranked reader
 * feed, which includes posts the user never queued — those must not be
 * auto-created; queue items arrive via the RSS pipeline instead (#192).
 */
export function shouldAutoAdd(source: SyncSource): boolean {
  // Progress harvesters (#192 Substack, #322 Apple Podcasts) are update-only.
  return source !== 'substack' && source !== 'apple_podcasts'
}

/** Listening sources share Spotify's completion policy (high-water progress,
 * sticky Completed/Awaiting comments, LessWrong → Awaiting comments). */
export function usesListeningRules(source?: SyncSource): boolean {
  return source === 'spotify' || source === 'apple_podcasts'
}

/** Apply automatic progress at the database write boundary (#266).
 * Spotify resolves source-aware completion under a row lock. Other integrations
 * preserve Awaiting comments atomically and optionally exclude archived items.
 */
export async function updateContentProgress(
  contentItemId: number,
  progress: string | null,
  status: 'In Progress' | 'Completed' | null,
  supabase: SupabaseClient,
  options?: { skipArchived?: boolean; source?: SyncSource }
): Promise<void> {
  if (progress === null && status === null) return
  const { error } = usesListeningRules(options?.source)
    ? await supabase.rpc('apply_spotify_progress', {
        // Apple Podcasts sends no source: it reports the Askwho Casts episode itself (#364).
        updates: [{ id: contentItemId, progress, status, ...(options?.source === 'spotify' ? { source: 'spotify' } : {}) }],
      })
    : await supabase.rpc('apply_content_progress', {
        p_item_id: contentItemId,
        p_progress: progress,
        p_status: status,
        p_skip_archived: options?.skipArchived ?? false,
      })
  if (error) {
    console.error('[Sync Matching] Error updating content progress:', error)
    throw error
  }
}

/**
 * Finishing a comments episode answers the card's "have you read the comments?"
 * (#368), so it does what the Done button does. Guarded at write time: on any
 * other status the listen changes nothing. A single-row update, so it needs no
 * multirow advisory lock.
 */
export async function completeAwaitingComments(contentItemId: number, supabase: SupabaseClient): Promise<void> {
  const { error } = await supabase
    .from('content_items')
    .update({
      status: 'Completed',
      status_changed_at: new Date().toISOString(),
      queue_position: null,
      position_confirmed: false,
    })
    .eq('id', contentItemId)
    .eq('status', AWAITING_COMMENTS)
  if (error) {
    console.error('[Sync Matching] Error completing awaiting-comments item:', error)
    throw error
  }
}

/**
 * Record a platform's own last-seen progress percent on its content_sources
 * row(s) (#194 per-source progress). Deliberately NOT a high-water mark: the
 * Resume-on-Spotify gate needs "is this source's position behind the item's
 * read position?", so regressions (e.g. a Spotify re-listen) must land too.
 * Matching 0 rows (source not created yet) is a silent no-op. Best-effort:
 * logs and swallows errors so a sync item never fails on this enrichment.
 *
 * @param contentItemId - Item whose source row to update
 * @param platform - The reporting platform ('Spotify', 'Substack', 'Audible')
 * @param normalizedProgress - normalizeProgress() output ('0'–'100'), or null to skip
 * @param supabase - Supabase client instance
 * @param sourceId - Optional exact content_sources row to write instead
 */
export async function updateSourceProgress(
  contentItemId: number,
  platform: string,
  normalizedProgress: string | null,
  supabase: SupabaseClient,
  sourceId?: number
): Promise<void> {
  if (normalizedProgress === null) return
  const progress = parseInt(normalizedProgress, 10)
  if (!Number.isFinite(progress)) return

  // With the exact matched row (#322: an item can carry several Askwho Casts
  // episode rows), write only that row; otherwise every row of the platform.
  const update = supabase.from('content_sources').update({ progress })
  const { error } = sourceId !== undefined
    ? await update.eq('id', sourceId)
    : await update.eq('content_item_id', contentItemId).eq('platform', platform)

  if (error) {
    console.error('[Sync Matching] Error updating source progress:', error)
  }
}

/**
 * Create new content item with source via RPC
 *
 * @param item - Sync item to create
 * @param source - Sync source platform
 * @param supabase - Supabase client instance
 * @param options - `skipPositioning: true` bypasses insertAtSmartPosition. Use
 *   for items that will never sit in the active queue (e.g. a Completed
 *   audiobook from the Audible sync) — positioning them only to clear the
 *   position again is wasted O(n) queue churn (#42), mirroring how the
 *   Goodreads importer bypasses smart-positioning for read books.
 *   `addedBy` overrides the `added_by` written for a brand-new row (default:
 *   `source`). The add-entry route passes 'Ben' (#381): a hand-add is the owner's
 *   pick, not an ingest source, while `source` still picks the platform fallback.
 * @returns The content item ID plus `inserted` — false when the RPC deduped
 *   onto a pre-existing item instead of creating a new row, so callers can
 *   report "existing" rather than a false "created" (#176).
 */
export async function createContent(
  item: SyncItem,
  source: SyncSource,
  supabase: SupabaseClient,
  options?: { skipPositioning?: boolean; addedBy?: string }
): Promise<{ contentItemId: number; inserted: boolean }> {
  // Map sync source to display platform name
  const platformMap: Record<SyncSource, string> = {
    spotify: 'Spotify',
    audible: 'Audible',
    substack: 'Substack',
    elevenreader: 'ElevenReader',
    tasklet: 'Tasklet',
    rss: 'RSS',
    goodreads: 'Goodreads',
    // Unreachable today (shouldAutoAdd is false), kept total for the type (#322).
    apple_podcasts: 'Askwho Casts',
  }

  const title = item.title.trim()
  const author = item.author.trim()
  const kind = item.kind ?? 'feed'
  const willPosition = !options?.skipPositioning

  // upsert_content_item RETURNS TABLE(content_id, inserted). createContent needs
  // `inserted` to decide orphan cleanup below, so it uses this richer entry point
  // rather than the scalar insert_or_update_content wrapper.
  const { data, error } = await supabase.rpc('upsert_content_item', {
    p_title: title,
    p_author: author,
    p_platform: item.platform || platformMap[source],
    // Pass NULL through for link-less sources (Physical / Library / Other).
    // The RPC normalizes empty/whitespace links to NULL.
    p_link: item.link ?? null,
    p_published_on: item.publishedOn || null,
    p_message_id: null,
    p_is_primary: true,
    p_external_id: item.externalId || null,
    p_added_by: options?.addedBy ?? source,
    // Kind is only applied to brand-new rows — existing items' kind is never
    // overwritten. Defaults to 'feed' when omitted.
    p_kind: kind,
    // Feed-card enrichment (#167) — also INSERT-only; null for items without it.
    p_image_url: item.imageUrl ?? null,
    p_word_count: item.wordCount ?? null,
    p_duration_seconds: item.durationSeconds ?? null,
    // Book metadata (#186) — INSERT-only; null for non-book / un-enriched items.
    p_isbn13: item.isbn13 ?? null,
    p_subtitle: item.subtitle ?? null,
    p_series: item.series ?? null,
  })

  if (error) {
    console.error('[Sync Matching] Error creating content:', error)
    throw error
  }

  // `inserted` is TRUE only when a brand-new content_items row was created (not
  // when a source was attached to an existing item) — the authoritative signal
  // for whether a post-insert failure could leave an orphan we may clean up (#176).
  const { contentId: contentItemId, inserted: insertedNewItem } = readInsertResult(data)

  // Smart-position the new item based on engagement scoring. Scoped to the
  // item's kind so the books queue is positioned independently from feed (#147).
  // Skipped for items that will be cleared from the queue anyway (e.g. Completed
  // audiobooks), which avoids needless full-queue renumbering (#42).
  //
  // Also skipped when the RPC deduped onto a pre-existing item: that item is
  // either already positioned or deliberately unpositioned, and if it's archived
  // (Completed/Skip) setting a position would violate the
  // completed_skip_no_position CHECK constraint (#176).
  //
  // The RPC commit above and this positioning are NOT one transaction (see
  // insertAtSmartPosition's note). If positioning throws, the row is already
  // committed at queue_position=NULL — an invisible orphan a later add would
  // read as a duplicate (false success, #176). So delete it via
  // delete_orphan_content_item (which re-checks the orphan state under a row
  // lock, so it never touches a positioned row), then rethrow.
  if (willPosition && insertedNewItem) {
    try {
      await insertAtSmartPosition(
        contentItemId,
        title,
        author,
        supabase,
        item.manuallyRequested,
        kind,
      )
    } catch (positionError) {
      const { error: cleanupError } = await supabase.rpc('delete_orphan_content_item', {
        p_id: contentItemId,
      })
      if (cleanupError) {
        console.error('[Sync Matching] Orphan cleanup failed:', cleanupError)
      }
      throw positionError
    }
  }

  return { contentItemId, inserted: insertedNewItem }
}

/**
 * Read the (content_id, inserted) result of the upsert_content_item RPC, which
 * RETURNS TABLE(...) → a one-row set (#176). `inserted` is true only when a
 * brand-new content_items row was created. Throws on an empty/unexpected shape.
 */
export function readInsertResult(data: unknown): { contentId: number; inserted: boolean } {
  const row = Array.isArray(data)
    ? (data[0] as { content_id?: number; inserted?: boolean } | undefined)
    : undefined
  if (!row || typeof row.content_id !== 'number') {
    throw new Error('upsert_content_item returned no row')
  }
  return { contentId: row.content_id, inserted: row.inserted === true }
}

/**
 * Ensure a Spotify content source exists for an existing content item.
 * Adds or updates the Spotify source with the correct link.
 *
 * @param contentItemId - ID of content item to update
 * @param link - Spotify episode URL
 * @param externalId - Spotify external ID (spotify:episode:xxx)
 * @param supabase - Supabase client instance
 */
export async function ensureSpotifySource(
  contentItemId: number,
  link: string,
  externalId: string,
  supabase: SupabaseClient
): Promise<void> {
  // Query existing Spotify source for this content
  // Use limit(1) instead of maybeSingle() to handle potential duplicates gracefully
  const { data: existingRows, error: queryError } = await supabase
    .from('content_sources')
    .select('id, link, external_id')
    .eq('content_item_id', contentItemId)
    .eq('platform', 'Spotify')
    .limit(1)

  const existing = existingRows?.[0] ?? null

  if (queryError) {
    console.error('[Sync Matching] Error querying Spotify source:', queryError)
    throw queryError
  }

  if (!existing) {
    // No Spotify source exists - clear other primaries and insert new one
    const { error: clearError } = await supabase
      .from('content_sources')
      .update({ is_primary: false })
      .eq('content_item_id', contentItemId)

    if (clearError) {
      console.warn('[Sync Matching] Failed to clear primary sources (may cause duplicate primaries):', clearError)
      // Non-fatal, continue with insert
    }

    const { error: insertError } = await supabase.from('content_sources').insert({
      content_item_id: contentItemId,
      platform: 'Spotify',
      link,
      external_id: externalId,
      is_primary: true,
    })

    if (insertError) {
      console.error('[Sync Matching] Error inserting Spotify source:', insertError)
      throw insertError
    }
  } else if (existing.link !== link) {
    // Spotify source exists but link differs - update it
    const { error: updateError } = await supabase
      .from('content_sources')
      .update({ link, external_id: externalId })
      .eq('id', existing.id)

    if (updateError) {
      console.error('[Sync Matching] Error updating Spotify source:', updateError)
      throw updateError
    }
  }
  // If link matches, do nothing
}

/**
 * Ensure a content source exists for an existing content item, for a non-primary
 * platform like RSS-attached Substack/LessWrong feeds.
 *
 * Differs from ensureSpotifySource: inserts with is_primary=false and does not
 * clear other primaries. Use when the RSS sync matches content that was
 * originally created by another platform (e.g., Spotify) and needs the feed's
 * own link attached without demoting the existing primary.
 *
 * @returns 'inserted' when a new row is created, 'updated' when an existing
 *   row's link is refreshed, 'unchanged' when the row already matches.
 */
export async function ensureRssSource(
  contentItemId: number,
  platform: string,
  link: string,
  externalId: string | undefined,
  supabase: SupabaseClient,
  // Set when a platform can hold several kinds of row for one item (#368): the
  // lookup and any insert stay within this label; null means unlabelled rows.
  opts?: { sourceLabel: string | null }
): Promise<'inserted' | 'updated' | 'unchanged'> {
  // A DB error can echo `link` in its message — for the Askwho Casts path
  // that's an enclosure URL embedding the feed bearer secret (#238 F1). Redact
  // it (and the secret path segment) before anything reaches the logs; the raw
  // error is still thrown for the caller, which redacts again before storing.
  // Only AWC links carry a secret, so ordinary RSS article URLs (whose path
  // segments are not secrets) are logged in full — redacting them would garble
  // legitimate error logs.
  const redact = (err: unknown) => {
    const message = serializeError(err).message
    return isAskwhocastsUrl(link) ? redactFeedSecret(message, link) : message
  }

  const lookup = supabase
    .from('content_sources')
    .select('id, link, external_id')
    .eq('content_item_id', contentItemId)
    .eq('platform', platform)
  const scoped = !opts
    ? lookup
    : opts.sourceLabel === null
      ? lookup.is('source_label', null)
      : lookup.eq('source_label', opts.sourceLabel)
  const { data: existingRows, error: queryError } = await scoped.limit(1)

  if (queryError) {
    console.error('[Sync Matching] Error querying RSS source:', redact(queryError))
    throw queryError
  }

  const existing = existingRows?.[0] ?? null

  if (!existing) {
    const { error: insertError } = await supabase.from('content_sources').insert({
      content_item_id: contentItemId,
      platform,
      link,
      external_id: externalId ?? null,
      is_primary: false,
      ...(opts?.sourceLabel ? { source_label: opts.sourceLabel } : {}),
    })

    if (insertError) {
      console.error('[Sync Matching] Error inserting RSS source:', redact(insertError))
      throw insertError
    }
    return 'inserted'
  }

  // A blank incoming link never overwrites a real stored one (#207): a
  // no-link post that title-matches this item must not wipe its URL.
  if (existing.link && !link.trim()) {
    return 'unchanged'
  }

  if (existing.link !== link) {
    // Omit external_id from the payload when the caller didn't supply one,
    // so a pre-existing value (set by another sync path) is preserved.
    const updatePayload: Record<string, unknown> = { link }
    if (externalId !== undefined) {
      updatePayload.external_id = externalId
    }

    const { error: updateError } = await supabase
      .from('content_sources')
      .update(updatePayload)
      .eq('id', existing.id)

    if (updateError) {
      console.error('[Sync Matching] Error updating RSS source:', redact(updateError))
      throw updateError
    }
    return 'updated'
  }

  return 'unchanged'
}

/**
 * Backfill a namespaced external_id onto an existing content item's source for
 * one platform, so future syncs match via Strategy 1 (exact external_id)
 * instead of re-running title/link matching every day (#192).
 *
 * Differs from ensureRssSource on purpose: that helper skips external_id
 * entirely when the row's link is unchanged, and overwrites the stored link
 * when it differs — both wrong here. This one only ever fills a NULL
 * external_id (never clobbers an existing value, never touches link), and
 * inserts a non-primary source when the platform has none.
 *
 * Tolerates the UNIQUE (platform, external_id) constraint: a 23505 means the
 * external_id is already attached to some row, which Strategy-1 matching
 * resolves on the next sync — a safe no-op, not a real failure.
 *
 * @returns 'set' when a NULL external_id was filled, 'inserted' when a new
 *   source row was created, 'unchanged' otherwise.
 */
export async function backfillExternalId(
  contentItemId: number,
  platform: string,
  link: string,
  externalId: string,
  supabase: SupabaseClient
): Promise<'set' | 'inserted' | 'unchanged'> {
  const { data: existingRows, error: queryError } = await supabase
    .from('content_sources')
    .select('id, external_id')
    .eq('content_item_id', contentItemId)
    .eq('platform', platform)
    .limit(1)

  if (queryError) {
    console.error('[Sync Matching] Error querying source for external_id backfill:', queryError)
    throw queryError
  }

  const existing = existingRows?.[0] ?? null

  if (existing) {
    if (existing.external_id !== null) {
      return 'unchanged'
    }

    const { error: updateError } = await supabase
      .from('content_sources')
      .update({ external_id: externalId })
      .eq('id', existing.id)

    if (updateError) {
      if ((updateError as { code?: string }).code === '23505') return 'unchanged'
      console.error('[Sync Matching] Error backfilling external_id:', updateError)
      throw updateError
    }
    return 'set'
  }

  const { error: insertError } = await supabase.from('content_sources').insert({
    content_item_id: contentItemId,
    platform,
    link,
    external_id: externalId,
    is_primary: false,
  })

  if (insertError) {
    if ((insertError as { code?: string }).code === '23505') return 'unchanged'
    console.error('[Sync Matching] Error inserting source for external_id backfill:', insertError)
    throw insertError
  }
  return 'inserted'
}

/**
 * Pre-fetched Spotify source data for batch operations
 */
export interface CachedSpotifySource {
  id: number
  link: string
  external_id: string | null
  // Stored per-source progress (#194) — lets the cron skip unchanged writes.
  progress: number | null
  // Show name for this row, if already labeled (#245). Lets the no-op check
  // below re-fire an UPDATE when a matched row is still missing its label.
  source_label: string | null
}

/**
 * Ensure a Spotify source row exists for this exact episode, given ALL of the
 * item's pre-fetched Spotify rows (skips the SELECT that ensureSpotifySource
 * would do). External_id-aware (#237): a row is only ever updated by its own
 * episode; a new episode on an item that already has Spotify rows gets an
 * additional row instead of clobbering. Pre-#237 this kept one row per item
 * and flip-flopped the link whenever two episodes matched the same item.
 *
 * @param contentItemId - ID of content item to update
 * @param link - Spotify episode URL
 * @param externalId - Spotify external ID (spotify:episode:xxx)
 * @param cachedSources - ALL pre-fetched Spotify rows for this item
 * @param supabase - Supabase client instance
 * @param sourceLabel - Spotify show name for this episode, or null (#245). Written
 *   on every insert/update so same-platform sources are distinguishable in the UI.
 */
export async function ensureSpotifySourceFromCache(
  contentItemId: number,
  link: string,
  externalId: string,
  cachedSources: CachedSpotifySource[],
  supabase: SupabaseClient,
  sourceLabel: string | null = null
): Promise<void> {
  // Same episode by external_id, or a legacy row (no external_id yet) with
  // the same link that this episode can adopt.
  const sameEpisode =
    cachedSources.find((s) => s.external_id === externalId) ??
    cachedSources.find((s) => s.external_id === null && s.link === link)

  if (sameEpisode) {
    // Re-fire the UPDATE when the label is stale too, so a row attached before
    // #245 (source_label NULL) gets named on the next sync — not just on a
    // link/external_id change.
    if (
      sameEpisode.link === link &&
      sameEpisode.external_id === externalId &&
      (sameEpisode.source_label ?? null) === sourceLabel
    ) {
      return
    }
    const { error: updateError } = await supabase
      .from('content_sources')
      .update({ link, external_id: externalId, source_label: sourceLabel })
      .eq('id', sameEpisode.id)

    if (updateError) {
      if (updateError.code === '23505') {
        // The external_id landed on another row concurrently — that row now
        // represents this episode; leave the legacy row for the next pass.
        console.warn('[Sync Matching] Spotify source adoption raced, skipping:', externalId)
        return
      }
      console.error('[Sync Matching] Error updating Spotify source:', updateError)
      throw updateError
    }
    return
  }

  if (cachedSources.length > 0) {
    // Item already has Spotify rows for OTHER episodes — add alongside them.
    const { error: insertError } = await supabase.from('content_sources').insert({
      content_item_id: contentItemId,
      platform: 'Spotify',
      link,
      external_id: externalId,
      is_primary: false,
      source_label: sourceLabel,
    })

    if (insertError && insertError.code !== '23505') {
      console.error('[Sync Matching] Error inserting Spotify source:', insertError)
      throw insertError
    }
    return
  }

  // No Spotify source exists — insert as primary FIRST, then demote the
  // others. Inserting first means a concurrent attach of the same episode
  // (23505, tolerated) can no longer leave the item with ZERO primary
  // sources, which clear-then-insert did when the insert lost the race.
  const { data: inserted, error: insertError } = await supabase
    .from('content_sources')
    .insert({
      content_item_id: contentItemId,
      platform: 'Spotify',
      link,
      external_id: externalId,
      is_primary: true,
      source_label: sourceLabel,
    })
    .select('id')
    .single()

  if (insertError) {
    if (insertError.code === '23505') return
    console.error('[Sync Matching] Error inserting Spotify source:', insertError)
    throw insertError
  }

  const { error: clearError } = await supabase
    .from('content_sources')
    .update({ is_primary: false })
    .eq('content_item_id', contentItemId)
    .neq('id', inserted.id)

  if (clearError) {
    console.warn('[Sync Matching] Failed to clear primary sources (may cause duplicate primaries):', clearError)
    // Non-fatal — a duplicate primary is benign vs a missing one
  }
}
