/**
 * Public Askwho Casts sync (#237).
 *
 * Attaches episodes of the public "AI Article Readings" Spotify show
 * (Askwho's articles production — 100% Askwho episodes, so pinning the show
 * ID is the only filtering needed) to matching queue items as additional
 * 'Spotify' content_sources rows. Uses spotify-sync's exact conventions
 * (platform 'Spotify', external_id `spotify:episode:<id>`) so the
 * resume/progress machinery treats these rows as its own.
 *
 * Attach-only: episodes with no matching item are reported, never imported.
 * Unmatched episodes are re-evaluated every run on purpose — an article
 * imported later gets its audio attached on the next pass.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchShowEpisodePages, type ShowEpisode } from '@/lib/spotify/client'
import { normalizeTitle, titlesAreFuzzyMatch } from '@/lib/sync/normalize-title'
import { AWC_PUBLIC_SHOW_LABEL } from '@/lib/media-type'

export const AWC_PUBLIC_SHOW_ID = '2w604VouzxpT0OsfvUe2f2'

export interface PublicEpisode {
  id: string
  title: string
  link: string
}

export interface PublicSyncResult {
  processed: number
  attached: number
  skipped: number
  unmatched: { title: string; link: string }[]
  itemErrors: number
}

interface Candidate {
  id: number
  title: string
  author: string
}

export function externalIdForEpisode(id: string): string {
  return `spotify:episode:${id}`
}

export function parsePublicEpisodes(items: ShowEpisode[]): PublicEpisode[] {
  return items.flatMap((item) => {
    const id = item.id?.trim()
    const title = item.name?.trim()
    const link = item.external_urls?.spotify?.trim()
    if (!id || !title || !link) return []
    return [{ id, title, link }]
  })
}

/**
 * Strip ONE rightmost title decoration the show appends: " - By <author>"
 * (dash/en/em/comma delimiter, optional space, any casing) or
 * " - ACX Book Review". Uses the LAST "by" delimiter so multi-attribution
 * titles like "JOINT REVIEW: <book>, by <book author>, By <reviewer>" keep
 * the inner attribution. Over-stripping is safe: it can only cause a
 * non-match (one-match-only rule in matchPublicEpisode), never a wrong match.
 */
export function stripEpisodeDecoration(title: string): string {
  const trimmed = title.trim()

  const acxStripped = trimmed.replace(/\s*[-–—,]\s*ACX(\s+Book)?\s+Review\s*$/i, '').trim()
  if (acxStripped !== trimmed) return acxStripped

  const delimiter = /\s*[-–—,]\s*by[:.]?\s+/gi
  let last: RegExpExecArray | null = null
  for (const m of trimmed.matchAll(delimiter)) {
    last = m
  }
  if (last && last.index > 0) {
    const tail = trimmed.slice(last.index + last[0].length)
    if (tail.length >= 2 && tail.length <= 60) {
      return trimmed.slice(0, last.index).trim()
    }
  }
  return trimmed
}

/**
 * Match an episode title against feed items. Tries both the raw and the
 * decoration-stripped title (exact normalized equality or fuzzy). Requires
 * exactly ONE distinct matching item — ambiguity means no match.
 */
export function matchPublicEpisode(title: string, candidates: Candidate[]): number | null {
  const forms = [
    ...new Set([normalizeTitle(title), normalizeTitle(stripEpisodeDecoration(title))]),
  ].filter((t) => t !== '')
  if (forms.length === 0) return null

  const matchedIds = new Set<number>()
  for (const candidate of candidates) {
    const normalized = normalizeTitle(candidate.title, candidate.author)
    if (normalized === '') continue
    if (forms.some((form) => form === normalized || titlesAreFuzzyMatch(form, normalized))) {
      matchedIds.add(candidate.id)
    }
  }
  return matchedIds.size === 1 ? [...matchedIds][0] : null
}

// PostgREST caps un-ranged selects at 1000 rows — page explicitly (#238 F2).
const PAGE_SIZE = 1000

async function fetchKnownEpisodeIds(supabase: SupabaseClient): Promise<Set<string>> {
  const known = new Set<string>()
  for (let from = 0; ; from += PAGE_SIZE) {
    // Stable order: .range() pages are only coherent under an explicit sort —
    // without it, concurrent writes can skip/duplicate rows across pages.
    const { data, error } = await supabase
      .from('content_sources')
      .select('external_id')
      .eq('platform', 'Spotify')
      .like('external_id', 'spotify:episode:%')
      .order('id')
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    for (const row of data) {
      if (row.external_id) known.add(row.external_id)
    }
    if (data.length < PAGE_SIZE) break
  }
  return known
}

async function fetchFeedCandidates(supabase: SupabaseClient): Promise<Candidate[]> {
  const candidates: Candidate[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('content_items')
      .select('id, title, author')
      .eq('kind', 'feed')
      .order('id')
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    candidates.push(...data)
    if (data.length < PAGE_SIZE) break
  }
  return candidates
}

export async function syncPublicEpisodes(
  accessToken: string,
  supabase: SupabaseClient
): Promise<PublicSyncResult> {
  const known = await fetchKnownEpisodeIds(supabase)

  let processed = 0
  let skipped = 0
  const fresh: PublicEpisode[] = []

  for await (const page of fetchShowEpisodePages(AWC_PUBLIC_SHOW_ID, accessToken)) {
    const episodes = parsePublicEpisodes(page)
    processed += episodes.length
    const unknown = episodes.filter((e) => !known.has(externalIdForEpisode(e.id)))
    skipped += episodes.length - unknown.length
    fresh.push(...unknown)
    // A fully-known page means we can stop fetching (newest-first). In
    // practice permanently-unmatched episodes keep pages "unknown", so this
    // mostly guards the everything-attached case; any new episode on page 1
    // resumes full paging next run.
    if (unknown.length === 0) break
  }

  if (fresh.length === 0) {
    return { processed, attached: 0, skipped, unmatched: [], itemErrors: 0 }
  }

  const candidates = await fetchFeedCandidates(supabase)

  let attached = 0
  let itemErrors = 0
  const unmatched: { title: string; link: string }[] = []

  for (const episode of fresh) {
    try {
      const contentItemId = matchPublicEpisode(episode.title, candidates)
      if (contentItemId === null) {
        unmatched.push({ title: episode.title, link: episode.link })
        continue
      }
      const { error } = await supabase.from('content_sources').insert({
        content_item_id: contentItemId,
        platform: 'Spotify',
        link: episode.link,
        external_id: externalIdForEpisode(episode.id),
        is_primary: false,
        // Tells this AI reading apart from a human-narrated episode of the same
        // post, which would otherwise show an identical "Open on Spotify" (#245).
        source_label: AWC_PUBLIC_SHOW_LABEL,
      })
      if (error) {
        if (error.code === '23505') {
          // Raced with spotify-sync (or a concurrent run) — row exists, fine.
          skipped++
          continue
        }
        throw error
      }
      attached++
    } catch (episodeError) {
      console.error('[AWC Public Sync] Error processing episode:', episode.title, episodeError)
      itemErrors++
    }
  }

  return { processed, attached, skipped, unmatched, itemErrors }
}
