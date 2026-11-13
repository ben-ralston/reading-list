// Askwho Casts private-feed episode matching (#226). Episodes are matched
// back to queue items primarily by article URL (Askwho canonicalizes links —
// strips www. — so exact matching needs variants), with an unambiguous
// normalized-title fallback. Script-tab (pasted text) episodes carry no
// <link>; they match only the awc_conversions request that produced them
// (#317). Idempotency + feed-rotation healing key on
// external_id = 'askwhocasts:<guid>' (guids are stable content hashes).

import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeTitle, titlesAreFuzzyMatch } from '@/lib/sync/normalize-title'
import { ensureRssSource } from '@/lib/sync/matching'
import { ASKWHOCASTS_PLATFORM, AWC_COMMENTS_LABEL } from '@/lib/media-type'
import { findGeneratingScriptConversion, markDoneForItem } from '@/lib/awc/conversions-repo'
import type { AwcKind } from '@/lib/awc/stages'

export interface AwcEpisode {
  guid: string
  title: string
  // Article URL from <link>; null for Script-tab episodes (#317).
  sourceUrl: string | null
  enclosureUrl: string
}

// Subset of rss-parser's item output we consume.
export interface AwcFeedItem {
  guid?: string
  title?: string
  link?: string
  enclosure?: { url?: string }
}

export type EpisodeResult = 'attached' | 'healed' | 'unchanged' | 'unmatched'

export function externalIdFor(guid: string): string {
  return `askwhocasts:${guid}`
}

export function parseAwcEpisodes(items: AwcFeedItem[]): AwcEpisode[] {
  return items.flatMap((item) => {
    const guid = item.guid?.trim()
    const title = item.title?.trim()
    const sourceUrl = item.link?.trim() || null
    const enclosureUrl = item.enclosure?.url?.trim()
    if (!guid || !title || !enclosureUrl) return []
    return [{ guid, title, sourceUrl, enclosureUrl }]
  })
}

// https/http × www/no-www × trailing-slash variants (plus the input verbatim),
// so an exact .in('link', …) match survives both sides' canonicalization.
export function linkVariants(url: string): string[] {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return [url]
  }
  const bareHost = parsed.host.replace(/^www\./, '')
  const rest = `${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`
  const variants = new Set<string>([url])
  for (const proto of ['https', 'http']) {
    for (const host of [bareHost, `www.${bareHost}`]) {
      variants.add(`${proto}://${host}${rest}`)
      variants.add(`${proto}://${host}${rest}/`)
    }
  }
  return [...variants]
}

async function matchEpisode(episode: AwcEpisode, supabase: SupabaseClient): Promise<{ contentItemId: number; kind: AwcKind } | null> {
  // Link-less (Script tab) episode: only the conversion request that produced
  // it may claim it — never the general title fallback below, so unrelated
  // Studio episodes stay unmatched (#317).
  if (episode.sourceUrl == null) {
    const request = await findGeneratingScriptConversion(supabase, episode.title)
    return request && { contentItemId: request.contentItemId, kind: request.kind }
  }

  // Primary: article-URL variants against stored sources (feed-kind only).
  const { data: linkRows, error: linkError } = await supabase
    .from('content_sources')
    .select('content_item_id, content_items!inner(kind)')
    .in('link', linkVariants(episode.sourceUrl))
    .eq('content_items.kind', 'feed')
    .limit(1)
  if (linkError) throw linkError
  if (linkRows && linkRows.length > 0) return { contentItemId: linkRows[0].content_item_id, kind: 'article' }

  // Fallback: unambiguous title match across feed items. normalizeTitle strips
  // the '"Title" by Author' decoration our RSS import applies, so the feed's
  // plain article title compares equal. Require exactly one match — a review
  // of the same article (e.g. item #1605) must not be attached by accident.
  const incoming = normalizeTitle(episode.title)
  if (incoming === '') return null
  // Page through every feed item: PostgREST caps an un-ranged select at 1000
  // rows, so past that the candidate set would be silently truncated and the
  // match missed (#238 F2). Stop when a short page signals the end.
  const PAGE_SIZE = 1000
  const candidates: { id: number; title: string; author: string }[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: page, error: titleError } = await supabase
      .from('content_items')
      .select('id, title, author')
      .eq('kind', 'feed')
      .range(from, from + PAGE_SIZE - 1)
    if (titleError) throw titleError
    if (!page || page.length === 0) break
    candidates.push(...page)
    if (page.length < PAGE_SIZE) break
  }
  const matches = candidates.filter((c) => {
    const normalized = normalizeTitle(c.title, c.author)
    return normalized !== '' && (normalized === incoming || titlesAreFuzzyMatch(incoming, normalized))
  })
  return matches.length === 1 ? { contentItemId: matches[0].id, kind: 'article' } : null
}

export async function syncEpisode(episode: AwcEpisode, supabase: SupabaseClient): Promise<EpisodeResult> {
  // Already imported? (guid is stable across feed-address rotation)
  const { data: existingRows, error: existingError } = await supabase
    .from('content_sources')
    .select('id, link, content_item_id, source_label')
    .eq('external_id', externalIdFor(episode.guid))
    .limit(1)
  if (existingError) throw existingError
  const existing = existingRows?.[0]
  if (existing) {
    // Re-close the item's conversion on every pass (#317): a markDone that
    // failed after the attach is retried here instead of leaving the row
    // 'generating' until the 24h sweep. No-op once the row is done.
    await markDoneForItem(supabase, existing.content_item_id, existing.source_label === AWC_COMMENTS_LABEL ? 'comments' : 'article')
    if (existing.link === episode.enclosureUrl) return 'unchanged'
    // Enclosure URLs embed the feed secret; after a rotation they change while
    // the guid stays put — heal the stored link so playback keeps working.
    const { error: healError } = await supabase
      .from('content_sources')
      .update({ link: episode.enclosureUrl })
      .eq('id', existing.id)
    if (healError) throw healError
    return 'healed'
  }

  const match = await matchEpisode(episode, supabase)
  if (match == null) return 'unmatched'
  const { contentItemId, kind } = match

  // A post can hold one article and one comments episode (#368): each only ever
  // updates its own row.
  await ensureRssSource(
    contentItemId,
    ASKWHOCASTS_PLATFORM,
    episode.enclosureUrl,
    externalIdFor(episode.guid),
    supabase,
    { sourceLabel: kind === 'comments' ? AWC_COMMENTS_LABEL : null }
  )
  // The episode for a requested conversion has landed (#317).
  await markDoneForItem(supabase, contentItemId, kind)
  return 'attached'
}
