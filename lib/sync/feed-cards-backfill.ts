/**
 * Feed-card backfill (#167): populate image_url on existing feed content_items
 * that predate the enrichment columns. image_url ONLY — writing word_count here
 * would leave image_url NULL on image-less rows and re-trip the selection filter
 * every run (word_count for old rows is left to a future re-sync, like duration).
 *
 * The thumbnail is the centerpiece, so the selection is "feed items with no
 * image_url". enrichFromUrl scrapes the item's source link for an og:image
 * (this also works for open.spotify.com / blog pages). Enriched rows gain an
 * image_url and drop out of the filter, so a re-run is idempotent (0 writes) for
 * everything that succeeded; items with genuinely no og:image stay null and are
 * harmlessly re-attempted (0 writes either way).
 *
 * duration_seconds is NOT backfilled: it isn't derivable from an article page
 * (only from the podcast/Spotify feed at sync time). New items get it going
 * forward; old audio items simply won't show a length until re-synced.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { enrichFromUrl } from '@/lib/rss/enrich'
import { runConcurrent } from './backfill-pool'

export interface FeedItemRow {
  id: number
  title: string
  link: string | null
}

export type BackfillEnrichAction = 'enriched' | 'no-image-found' | 'no-link' | 'failed'

export interface EnrichResult {
  id: number
  title: string
  action: BackfillEnrichAction
  imageUrl: string | null
  wordCount: number | null
}

interface SourceRow {
  link: string | null
  is_primary: boolean
}

/**
 * Select feed items still missing image_url, resolving each to a usable source
 * link (primary first). Ordered by id for stable, resumable batches.
 */
export async function findFeedItemsNeedingImage(
  supabase: SupabaseClient,
  limit?: number,
): Promise<FeedItemRow[]> {
  let query = supabase
    .from('content_items')
    .select('id, title, sources:content_sources(link, is_primary)')
    .eq('kind', 'feed')
    .is('image_url', null)
    .order('id', { ascending: true })

  if (limit) query = query.limit(limit)

  const { data, error } = await query
  if (error) throw error

  return (data ?? []).map((row) => {
    const sources = ((row as { sources?: SourceRow[] }).sources ?? [])
    const primary = sources.find((s) => s.is_primary) ?? sources[0]
    return {
      id: (row as { id: number }).id,
      title: (row as { title: string }).title,
      link: primary?.link ?? null,
    }
  })
}

/**
 * Enrich a single feed item: scrape its link for an og:image and, when found,
 * write `image_url` (only — see module note on idempotency; word_count is left
 * to the sync path). Best-effort and never throws — failures become a 'failed'
 * result so the batch keeps going. In dry-run mode it computes the result but
 * performs no write. The UPDATE is guarded with `.is('image_url', null)` so a
 * concurrent writer that filled the field first isn't clobbered.
 */
export async function enrichOneFeedItem(
  row: FeedItemRow,
  supabase: SupabaseClient,
  opts: { dryRun: boolean },
): Promise<EnrichResult> {
  if (!row.link) {
    return { id: row.id, title: row.title, action: 'no-link', imageUrl: null, wordCount: null }
  }

  let enriched: { imageUrl: string | null; wordCount: number | null }
  try {
    enriched = await enrichFromUrl(row.link)
  } catch {
    return { id: row.id, title: row.title, action: 'failed', imageUrl: null, wordCount: null }
  }

  // No image → no write. Writing word_count alone would leave image_url NULL,
  // so the "image_url IS NULL" selection would re-scrape this row every run.
  if (!enriched.imageUrl) {
    return { id: row.id, title: row.title, action: 'no-image-found', imageUrl: null, wordCount: null }
  }

  if (!opts.dryRun) {
    const { error } = await supabase
      .from('content_items')
      .update({ image_url: enriched.imageUrl })
      .is('image_url', null)
      .eq('id', row.id)
    if (error) {
      return { id: row.id, title: row.title, action: 'failed', ...enriched }
    }
  }

  return { id: row.id, title: row.title, action: 'enriched', imageUrl: enriched.imageUrl, wordCount: enriched.wordCount }
}

/**
 * Run enrichOneFeedItem over many rows with a small concurrency pool (polite to
 * the sites we scrape). Returns results in input order.
 */
export async function enrichFeedItems(
  rows: FeedItemRow[],
  supabase: SupabaseClient,
  opts: { dryRun: boolean; concurrency?: number },
): Promise<EnrichResult[]> {
  return runConcurrent(
    rows,
    (row) => enrichOneFeedItem(row, supabase, { dryRun: opts.dryRun }),
    opts.concurrency ?? 5,
  )
}
