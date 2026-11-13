/**
 * Interactive RSS backfill core.
 *
 * Thin orchestration over the matching primitives in `lib/sync/matching.ts`:
 * given parsed feed posts, decide which are already in the DB ("matched") vs.
 * genuinely missing, and apply a user-chosen selection by creating the missing
 * content_items (or attaching the feed source to ones that turn out to match).
 *
 * Used by `scripts/rss-backfill-preview.ts` (read-only classify → HTML) and
 * `scripts/rss-backfill-apply.ts` (writer). Designed to be idempotent and
 * dedup-safe: every write goes through `findMatchingContent` first, so a re-run
 * over the same selection creates nothing.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  findMatchingContent,
  createContent,
  ensureRssSource,
  type SyncItem,
} from '@/lib/sync/matching'
import { normalizeTitle } from '@/lib/sync/normalize-title'

/** A parsed feed post (parser output shape — no queue-position intent yet). */
export type BackfillPost = Omit<SyncItem, 'manuallyRequested'>

export type PostStatus = 'matched' | 'missing' | 'ambiguous'

export interface ClassifiedPost {
  item: BackfillPost
  publishedOn: string | null
  status: PostStatus
  /** Present when status === 'matched'. */
  contentItemId?: number
}

export interface ClassifyOptions {
  /** How far back to include posts. Default 90 days. */
  windowDays?: number
  /** Injectable clock for testing. Default `new Date()`. */
  now?: Date
}

export type ApplyAction = 'created' | 'source-attached' | 'unchanged' | 'skipped-ambiguous'

export interface ApplyResult {
  item: BackfillPost
  action: ApplyAction
  /** The owning content_item id (new for 'created', existing otherwise). */
  contentItemId?: number
}

export interface ApplyOptions {
  /** When true, plan actions but perform no writes. Default false. */
  dryRun?: boolean
}

/**
 * Find normalized title keys shared by two or more posts with *different* links.
 * Mirrors the guard in the #135 backfill scripts: `findMatchingContent` is
 * title-based, so two distinct posts sharing a normalized title would both map
 * to the same content_item and clobber each other. Same-title/same-link posts
 * are not ambiguous (they're the same post seen twice). A missing link counts
 * as the distinct value '' (#207): a no-link post sharing a title with a
 * linked post is ambiguous, while two no-link same-title posts are treated as
 * the same post seen twice.
 */
function ambiguousTitleKeys(posts: BackfillPost[]): Set<string> {
  const linksByKey = new Map<string, Set<string>>()
  for (const p of posts) {
    const link = p.link?.trim() ?? ''
    const key = normalizeTitle(p.title ?? '', p.author)
    if (!key) continue
    if (!linksByKey.has(key)) linksByKey.set(key, new Set())
    linksByKey.get(key)!.add(link)
  }
  const ambiguous = new Set<string>()
  for (const [key, links] of linksByKey) {
    if (links.size > 1) ambiguous.add(key)
  }
  return ambiguous
}

function titleKey(p: BackfillPost): string {
  return normalizeTitle(p.title ?? '', p.author)
}

function publishedTime(p: BackfillPost): number | null {
  if (!p.publishedOn) return null
  const t = new Date(p.publishedOn).getTime()
  return Number.isNaN(t) ? null : t
}

/**
 * Classify a feed's parsed posts for the backfill preview UI.
 *
 * Read-only. Returns in-window posts sorted newest→oldest (undated last), each
 * flagged matched / missing / ambiguous. Matched posts carry their existing
 * content_item id. Ambiguous posts are excluded from creation by the apply step.
 */
export async function classifyFeedPosts(
  posts: BackfillPost[],
  supabase: SupabaseClient,
  options?: ClassifyOptions
): Promise<ClassifiedPost[]> {
  const windowDays = options?.windowDays ?? 90
  const now = options?.now ?? new Date()
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000

  // In-window = dated within the window, or undated (date can't exclude it).
  const inWindow = posts.filter((p) => {
    const t = publishedTime(p)
    return t === null || t >= cutoff
  })

  const ambiguous = ambiguousTitleKeys(inWindow)

  const classified: ClassifiedPost[] = []
  for (const item of inWindow) {
    const key = titleKey(item)
    if (key && ambiguous.has(key)) {
      classified.push({ item, publishedOn: item.publishedOn ?? null, status: 'ambiguous' })
      continue
    }
    const match = await findMatchingContent({ ...item, manuallyRequested: false }, supabase)
    classified.push(
      match
        ? {
            item,
            publishedOn: item.publishedOn ?? null,
            status: 'matched',
            contentItemId: match.contentItemId,
          }
        : { item, publishedOn: item.publishedOn ?? null, status: 'missing' }
    )
  }

  // Newest first; undated sinks to the bottom.
  classified.sort((a, b) => {
    const ta = publishedTime(a.item)
    const tb = publishedTime(b.item)
    if (ta === null && tb === null) return 0
    if (ta === null) return 1
    if (tb === null) return -1
    return tb - ta
  })

  return classified
}

/**
 * Apply a user-selected set of posts.
 *
 * For each post: match first. If it already exists, attach the feed's own
 * platform source (idempotent — no duplicate content_item). If it doesn't,
 * create it as a normal RSS sync would. Posts whose normalized title collides
 * with another in the selection are skipped to avoid clobbering.
 *
 * `dryRun` plans the same actions without performing any writes.
 */
export async function applyBackfillSelection(
  posts: BackfillPost[],
  supabase: SupabaseClient,
  options?: ApplyOptions
): Promise<ApplyResult[]> {
  const dryRun = options?.dryRun ?? false
  const ambiguous = ambiguousTitleKeys(posts)

  const results: ApplyResult[] = []
  for (const item of posts) {
    const key = titleKey(item)
    if (key && ambiguous.has(key)) {
      results.push({ item, action: 'skipped-ambiguous' })
      continue
    }

    const match = await findMatchingContent({ ...item, manuallyRequested: false }, supabase)

    if (match) {
      // A no-link post has nothing to attach — and passing '' through would
      // overwrite the matched item's real source link (#207).
      const link = item.link?.trim()
      if (!link) {
        results.push({ item, action: 'unchanged', contentItemId: match.contentItemId })
        continue
      }
      if (dryRun) {
        results.push({ item, action: 'source-attached', contentItemId: match.contentItemId })
        continue
      }
      const outcome = await ensureRssSource(
        match.contentItemId,
        item.platform,
        link,
        undefined,
        supabase
      )
      results.push({
        item,
        action: outcome === 'unchanged' ? 'unchanged' : 'source-attached',
        contentItemId: match.contentItemId,
      })
      continue
    }

    if (dryRun) {
      results.push({ item, action: 'created' })
      continue
    }
    const { contentItemId: newId } = await createContent({ ...item, manuallyRequested: false }, 'rss', supabase)
    results.push({ item, action: 'created', contentItemId: newId })
  }

  return results
}
