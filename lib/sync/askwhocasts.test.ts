import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseAwcEpisodes, linkVariants, syncEpisode, type AwcEpisode } from './askwhocasts'
import { ASKWHOCASTS_PLATFORM } from '@/lib/media-type'

vi.mock('@/lib/awc/conversions-repo', () => ({
  findGeneratingScriptConversion: vi.fn(),
  markDoneForItem: vi.fn().mockResolvedValue(undefined),
}))
import { findGeneratingScriptConversion, markDoneForItem } from '@/lib/awc/conversions-repo'

const EPISODE: AwcEpisode = {
  guid: '69f79372…hash…',
  title: 'A global workspace in language models',
  sourceUrl: 'https://lesswrong.com/posts/3PaLrzxagpbnNtPLT/a-global-workspace-in-language-models',
  enclosureUrl: 'https://app.askwhocasts.com/f/SECRET/media/69f79372.mp3',
}

describe('parseAwcEpisodes', () => {
  it('maps rss-parser items and drops incomplete ones', () => {
    const items = [
      { guid: 'g1', title: 'T', link: 'https://a.example/p', enclosure: { url: 'https://m.example/1.mp3' } },
      { guid: 'g2', title: 'No enclosure', link: 'https://a.example/q' },
      { title: 'No guid', link: 'https://a.example/r', enclosure: { url: 'https://m.example/2.mp3' } },
    ]
    expect(parseAwcEpisodes(items)).toEqual([
      { guid: 'g1', title: 'T', sourceUrl: 'https://a.example/p', enclosureUrl: 'https://m.example/1.mp3' },
    ])
  })

  it('keeps link-less (Script tab) episodes with sourceUrl null (#317)', () => {
    expect(parseAwcEpisodes([{ guid: 'g', title: 'Studio ep', enclosure: { url: 'https://m/1.mp3' } }]))
      .toEqual([{ guid: 'g', title: 'Studio ep', sourceUrl: null, enclosureUrl: 'https://m/1.mp3' }])
  })
})

describe('linkVariants', () => {
  it('covers scheme, www, and trailing-slash variants', () => {
    const variants = linkVariants('https://lesswrong.com/posts/x/y')
    expect(variants).toContain('https://www.lesswrong.com/posts/x/y') // the real stored form
    expect(variants).toContain('http://lesswrong.com/posts/x/y')
    expect(variants).toContain('https://lesswrong.com/posts/x/y/')
  })
  it('returns the input alone for an unparseable URL', () => {
    expect(linkVariants('not a url')).toEqual(['not a url'])
  })
})

// ---------------------------------------------------------------------------
// Supabase mock helper (modeled on createMockSupabase in lib/sync/matching.test.ts,
// extended to cover this module's three query shapes: content_sources by
// external_id, content_sources by .in('link', …) joined to content_items!inner(kind),
// and content_items by kind — plus an update spy for the heal case and an
// insert spy for ensureRssSource's attach path.)
// ---------------------------------------------------------------------------

interface MockContentItem {
  id: number
  title: string
  author: string
}

interface MockSourceByLink {
  content_item_id: number
  link: string
}

interface MockSourceByContentItem {
  id: number
  link: string
  external_id: string | null
}

function createMockSupabase(options: {
  sourceByExternalId?: { id: number; link: string } | null
  sourcesByLink?: MockSourceByLink[]
  contentItems?: MockContentItem[]
  sourcesByContentItem?: Record<number, MockSourceByContentItem | null>
}) {
  const {
    sourceByExternalId = null,
    sourcesByLink = [],
    contentItems = [],
    sourcesByContentItem = {},
  } = options

  const updateEq = vi.fn().mockResolvedValue({ error: null })
  const update = vi.fn().mockReturnValue({ eq: updateEq })
  const insert = vi.fn().mockResolvedValue({ error: null })

  const from = vi.fn().mockImplementation((table: string) => {
    if (table === 'content_sources') {
      return {
        select: vi.fn().mockImplementation((cols: string) => {
          if (cols.includes('content_items!inner')) {
            // matchEpisode's link-variant query
            return {
              in: vi.fn().mockImplementation((_field: string, values: string[]) => ({
                eq: vi.fn().mockImplementation(() => ({
                  limit: vi.fn().mockResolvedValue({
                    data: sourcesByLink.filter((s) => values.includes(s.link)),
                    error: null,
                  }),
                })),
              })),
            }
          }
          // Either syncEpisode's external_id lookup, or ensureRssSource's
          // content_item_id + platform lookup — disambiguate on the field.
          return {
            eq: vi.fn().mockImplementation((field: string, value: unknown) => {
              if (field === 'external_id') {
                return {
                  limit: vi.fn().mockResolvedValue({
                    data: sourceByExternalId ? [sourceByExternalId] : [],
                    error: null,
                  }),
                }
              }
              if (field === 'content_item_id') {
                const existing = sourcesByContentItem[value as number] ?? null
                const limit = vi.fn().mockResolvedValue({ data: existing ? [existing] : [], error: null })
                return {
                  eq: vi.fn().mockImplementation(() => ({
                    limit,
                    // ensureRssSource's source_label filter (#368).
                    is: vi.fn().mockReturnValue({ limit }),
                    eq: vi.fn().mockReturnValue({ limit }),
                  })),
                }
              }
              throw new Error(`createMockSupabase: unexpected eq field "${field}"`)
            }),
          }
        }),
        update,
        insert,
      }
    }
    if (table === 'content_items') {
      // Simulate PostgREST: an un-ranged select is capped at 1000 rows, while
      // .range(from, to) returns the requested inclusive slice. Awaiting the
      // .eq() result yields the capped page (legacy path); .range() paginates.
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockImplementation(() => {
            const capped = Promise.resolve({ data: contentItems.slice(0, 1000), error: null })
            return Object.assign(capped, {
              range: (from: number, to: number) =>
                Promise.resolve({ data: contentItems.slice(from, to + 1), error: null }),
            })
          }),
        }),
      }
    }
    throw new Error(`createMockSupabase: unexpected table "${table}"`)
  })

  return { from, update, updateEq, insert } as any
}

describe('syncEpisode', () => {
  it('returns unchanged when the guid external_id already exists with the same link', async () => {
    const supabase = createMockSupabase({
      sourceByExternalId: { id: 501, link: EPISODE.enclosureUrl },
    })

    const result = await syncEpisode(EPISODE, supabase)

    expect(result).toBe('unchanged')
    expect(supabase.update).not.toHaveBeenCalled()
    expect(supabase.insert).not.toHaveBeenCalled()
  })

  it('heals the stored link when the feed was rotated (same guid, new enclosure URL)', async () => {
    const oldLink = 'https://app.askwhocasts.com/f/OLDSECRET/media/69f79372.mp3'
    const supabase = createMockSupabase({
      sourceByExternalId: { id: 502, link: oldLink },
    })

    const result = await syncEpisode(EPISODE, supabase)

    expect(result).toBe('healed')
    expect(supabase.update).toHaveBeenCalledWith({ link: EPISODE.enclosureUrl })
    expect(supabase.updateEq).toHaveBeenCalledWith('id', 502)
  })

  it('attaches via ensureRssSource when a link variant matches a stored source', async () => {
    const supabase = createMockSupabase({
      sourceByExternalId: null,
      // the real stored form (www., per the module's link-canonicalization note)
      sourcesByLink: [
        { content_item_id: 4200, link: 'https://www.lesswrong.com/posts/3PaLrzxagpbnNtPLT/a-global-workspace-in-language-models' },
      ],
      sourcesByContentItem: { 4200: null },
    })

    const result = await syncEpisode(EPISODE, supabase)

    expect(result).toBe('attached')
    expect(supabase.insert).toHaveBeenCalledWith({
      content_item_id: 4200,
      platform: ASKWHOCASTS_PLATFORM,
      link: EPISODE.enclosureUrl,
      external_id: `askwhocasts:${EPISODE.guid}`,
      is_primary: false,
    })
  })

  it('falls back to unambiguous normalized-title match (decorated queue title)', async () => {
    const supabase = createMockSupabase({
      sourceByExternalId: null,
      sourcesByLink: [],
      contentItems: [
        {
          id: 1591,
          title: '"A global workspace in language models" by wesg',
          author: 'LessWrong (Curated & Popular)',
        },
      ],
      sourcesByContentItem: { 1591: null },
    })

    const result = await syncEpisode(EPISODE, supabase)

    expect(result).toBe('attached')
    expect(supabase.insert).toHaveBeenCalledWith({
      content_item_id: 1591,
      platform: ASKWHOCASTS_PLATFORM,
      link: EPISODE.enclosureUrl,
      external_id: `askwhocasts:${EPISODE.guid}`,
      is_primary: false,
    })
  })

  it('returns unmatched when two items share the normalized title (ambiguous — attaching to either could be wrong)', async () => {
    const supabase = createMockSupabase({
      sourceByExternalId: null,
      sourcesByLink: [],
      // e.g. the article itself and a review titled identically after
      // normalizeTitle strips the '"…" by author' decoration
      contentItems: [
        {
          id: 1591,
          title: '"A global workspace in language models" by wesg',
          author: 'LessWrong (Curated & Popular)',
        },
        {
          id: 1605,
          title: 'A global workspace in language models',
          author: 'Someone Reviewing',
        },
      ],
      sourcesByContentItem: { 1591: null, 1605: null },
    })

    const result = await syncEpisode(EPISODE, supabase)

    expect(result).toBe('unmatched')
    expect(supabase.update).not.toHaveBeenCalled()
    expect(supabase.insert).not.toHaveBeenCalled()
  })

  it('paginates past the PostgREST 1000-row cap to find a title match beyond the first page (#238 F2)', async () => {
    // 1000 non-matching feed items fill the first page; the real match sits at
    // index 1000 (page 2). A single un-paginated query would miss it.
    const filler = Array.from({ length: 1000 }, (_, i) => ({
      id: 10_000 + i,
      title: `Unrelated article ${i}`,
      author: 'Nobody',
    }))
    const match = {
      id: 1591,
      title: '"A global workspace in language models" by wesg',
      author: 'LessWrong (Curated & Popular)',
    }
    const supabase = createMockSupabase({
      sourceByExternalId: null,
      sourcesByLink: [],
      contentItems: [...filler, match],
      sourcesByContentItem: { 1591: null },
    })

    const result = await syncEpisode(EPISODE, supabase)

    expect(result).toBe('attached')
    expect(supabase.insert).toHaveBeenCalledWith(
      expect.objectContaining({ content_item_id: 1591 })
    )
  })

  it('returns unmatched when neither link nor title matches', async () => {
    const supabase = createMockSupabase({
      sourceByExternalId: null,
      sourcesByLink: [],
      contentItems: [{ id: 999, title: 'Something Completely Different', author: 'Someone Else' }],
    })

    const result = await syncEpisode(EPISODE, supabase)

    expect(result).toBe('unmatched')
    expect(supabase.update).not.toHaveBeenCalled()
    expect(supabase.insert).not.toHaveBeenCalled()
  })
})

describe('syncEpisode — conversion requests (#317)', () => {
  beforeEach(() => vi.clearAllMocks())
  const LINKLESS: AwcEpisode = { ...EPISODE, guid: 'studio-1', title: 'Your Wisconsin Primary, Researched', sourceUrl: null }

  it('attaches a link-less episode to the item of the matching generating script request and marks it done', async () => {
    vi.mocked(findGeneratingScriptConversion).mockResolvedValue({ id: 3, contentItemId: 77, kind: 'article' })
    const supabase = createMockSupabase({ sourcesByContentItem: { 77: null } })
    expect(await syncEpisode(LINKLESS, supabase)).toBe('attached')
    expect(findGeneratingScriptConversion).toHaveBeenCalledWith(supabase, 'Your Wisconsin Primary, Researched')
    expect(supabase.insert).toHaveBeenCalledWith(expect.objectContaining({ content_item_id: 77, platform: ASKWHOCASTS_PLATFORM }))
    expect(markDoneForItem).toHaveBeenCalledWith(supabase, 77, 'article')
  })

  it('leaves unrelated link-less episodes unmatched (no general title fallback)', async () => {
    vi.mocked(findGeneratingScriptConversion).mockResolvedValue(null)
    const supabase = createMockSupabase({ contentItems: [{ id: 1, title: 'Your Wisconsin Primary, Researched', author: 'X' }] })
    expect(await syncEpisode(LINKLESS, supabase)).toBe('unmatched')
    expect(supabase.from).not.toHaveBeenCalledWith('content_items')
    expect(markDoneForItem).not.toHaveBeenCalled()
  })

  it('marks the item’s active conversion done after a URL-matched attach', async () => {
    const supabase = createMockSupabase({
      sourcesByLink: [{ content_item_id: 42, link: 'https://www.lesswrong.com/posts/3PaLrzxagpbnNtPLT/a-global-workspace-in-language-models' }],
      sourcesByContentItem: { 42: null },
    })
    expect(await syncEpisode(EPISODE, supabase)).toBe('attached')
    expect(markDoneForItem).toHaveBeenCalledWith(supabase, 42, 'article')
  })
})

describe('syncEpisode — completion retry (#317 review)', () => {
  beforeEach(() => vi.clearAllMocks())
  it('marks the conversion done on the unchanged path too (a failed markDone gets retried next sync)', async () => {
    const supabase = createMockSupabase({ sourceByExternalId: { id: 501, link: EPISODE.enclosureUrl, content_item_id: 42 } as never })
    expect(await syncEpisode(EPISODE, supabase)).toBe('unchanged')
    expect(markDoneForItem).toHaveBeenCalledWith(supabase, 42, 'article')
  })
  it('marks the conversion done on the healed path too', async () => {
    const supabase = createMockSupabase({ sourceByExternalId: { id: 502, link: 'https://old/x.mp3', content_item_id: 43 } as never })
    expect(await syncEpisode(EPISODE, supabase)).toBe('healed')
    expect(markDoneForItem).toHaveBeenCalledWith(supabase, 43, 'article')
  })
})

describe('comments episodes (#368)', () => {
  const COMMENTS: AwcEpisode = {
    guid: 'c1', title: 'Comments: T', sourceUrl: null,
    enclosureUrl: 'https://app.askwhocasts.com/f/SECRET/media/c1.mp3',
  }
  beforeEach(() => {
    vi.mocked(markDoneForItem).mockClear()
    vi.mocked(findGeneratingScriptConversion).mockReset()
  })

  it('attaches a comments episode with its label and closes only the comments request', async () => {
    vi.mocked(findGeneratingScriptConversion).mockResolvedValue({ id: 3, contentItemId: 7, kind: 'comments' })
    const supabase = createMockSupabase({})
    expect(await syncEpisode(COMMENTS, supabase)).toBe('attached')
    expect(supabase.insert).toHaveBeenCalledWith(expect.objectContaining({ content_item_id: 7, source_label: 'Comments', external_id: 'askwhocasts:c1' }))
    expect(markDoneForItem).toHaveBeenCalledWith(supabase, 7, 'comments')
  })
  it('attaches a Script-path article episode without a label', async () => {
    vi.mocked(findGeneratingScriptConversion).mockResolvedValue({ id: 3, contentItemId: 7, kind: 'article' })
    const supabase = createMockSupabase({})
    await syncEpisode({ ...COMMENTS, title: 'T' }, supabase)
    expect(supabase.insert.mock.calls[0][0]).not.toHaveProperty('source_label')
    expect(markDoneForItem).toHaveBeenCalledWith(supabase, 7, 'article')
  })
  it('re-closes only the comments request on later passes', async () => {
    const supabase = createMockSupabase({
      sourceByExternalId: { id: 1, link: COMMENTS.enclosureUrl, content_item_id: 7, source_label: 'Comments' } as never,
    })
    expect(await syncEpisode(COMMENTS, supabase)).toBe('unchanged')
    expect(markDoneForItem).toHaveBeenCalledWith(supabase, 7, 'comments')
  })
  it('an existing article episode never closes a comments request', async () => {
    const supabase = createMockSupabase({
      sourceByExternalId: { id: 1, link: EPISODE.enclosureUrl, content_item_id: 7, source_label: null } as never,
    })
    await syncEpisode(EPISODE, supabase)
    expect(markDoneForItem).toHaveBeenCalledWith(supabase, 7, 'article')
  })
})
