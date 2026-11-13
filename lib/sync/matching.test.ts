import { describe, it, expect, vi, beforeEach } from 'vitest'
import { findMatchingContent, findByExternalId, usesListeningRules, completeAwaitingComments, ensureRssSource, ensureSpotifySourceFromCache, createContent, readInsertResult, shouldAutoAdd, backfillExternalId, updateContentProgress, updateSourceProgress, SyncItem, SyncSource } from './matching'
import { SupabaseClient } from '@supabase/supabase-js'

// Mock engagement module
vi.mock('@/lib/scoring/engagement', () => ({
  getAuthorAliases: vi.fn(),
}))

// Mock queue-position module (createContent calls insertAtSmartPosition)
vi.mock('@/lib/scoring/queue-position', () => ({
  insertAtSmartPosition: vi.fn(),
}))

import { getAuthorAliases } from '@/lib/scoring/engagement'
import { insertAtSmartPosition } from '@/lib/scoring/queue-position'
const mockGetAuthorAliases = vi.mocked(getAuthorAliases)
const mockInsertAtSmartPosition = vi.mocked(insertAtSmartPosition)

// ---------------------------------------------------------------------------
// Supabase mock helper
// ---------------------------------------------------------------------------

interface MockContentItem {
  id: number
  title: string
  author: string
}

interface MockSource {
  id: number
  content_item_id: number
}

interface MockSourceWithLink {
  id: number
  content_item_id: number
  link: string
}

function createMockSupabase(options: {
  sources?: MockSource[]
  contentItems?: MockContentItem[]
  sourcesByLink?: MockSourceWithLink[]
}) {
  const { sources = [], contentItems = [], sourcesByLink = [] } = options

  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'content_sources') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockImplementation((field: string, value: unknown) => {
              if (field === 'link') {
                // Strategy 4: link-based match. The route now kind-scopes
                // via an inner join, so it chains a second .eq('content_items.kind', kind)
                // before .limit(). Support both shapes.
                const linkMatches = sourcesByLink.filter((s) => s.link === value)
                const linkResult = {
                  limit: vi.fn().mockResolvedValue({ data: linkMatches, error: null }),
                }
                return {
                  eq: vi.fn().mockReturnValue(linkResult),
                  ...linkResult,
                }
              }
              // Strategy 1: external_id match (default)
              return {
                maybeSingle: vi.fn().mockResolvedValue({
                  data: sources[0] ?? null,
                  error: null,
                }),
              }
            }),
          }),
        }
      }
      if (table === 'content_items') {
        const ilikeMock = vi.fn().mockImplementation((_field: string, authorValue: string) => {
          const filtered = contentItems.filter(
            (item) => item.author.toLowerCase() === authorValue.toLowerCase()
          )
          return Promise.resolve({ data: filtered, error: null })
        })
        return {
          select: vi.fn().mockReturnValue({
            // Kind-scoped author lookup: .eq('kind', …) lands before .ilike(…).
            eq: vi.fn().mockReturnValue({ ilike: ilikeMock }),
          }),
        }
      }
      return {
        select: vi.fn().mockResolvedValue({ data: [], error: null }),
      }
    }),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  } as any
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('findMatchingContent', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    // Default: no aliases
    mockGetAuthorAliases.mockResolvedValue([])
  })

  describe('Strategy 1: external ID match', () => {
    it('matches by external_id', async () => {
      const supabase = createMockSupabase({
        sources: [{ id: 10, content_item_id: 42 }],
      })

      const item: SyncItem = {
        title: 'Some Title',
        author: 'Author',
        platform: 'Spotify',
        externalId: 'spotify:episode:abc123',
      }

      const result = await findMatchingContent(item, supabase)
      expect(result).toEqual({
        contentItemId: 42,
        sourceId: 10,
        action: 'update',
      })
    })

    it('returns null and falls through when no external_id match', async () => {
      const supabase = createMockSupabase({
        sources: [],
        contentItems: [],
      })
      // Need to fix the mock for empty sources — maybeSingle returns null
      supabase.from.mockImplementation((table: string) => {
        if (table === 'content_sources') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
          }
        }
        if (table === 'content_items') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                ilike: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          }
        }
        return { select: vi.fn().mockResolvedValue({ data: [], error: null }) }
      })

      mockGetAuthorAliases.mockResolvedValue(['author'])

      const item: SyncItem = {
        title: 'No Match',
        author: 'Author',
        platform: 'Spotify',
        externalId: 'spotify:episode:missing',
      }

      const result = await findMatchingContent(item, supabase)
      expect(result).toBeNull()
    })
  })

  describe('Normalized title + author match', () => {
    it('matches with exact normalized title', async () => {
      const supabase = createMockSupabase({
        contentItems: [
          { id: 1, title: 'The Great Article', author: 'John Smith' },
        ],
      })
      mockGetAuthorAliases.mockResolvedValue(['john smith'])

      const item: SyncItem = {
        title: 'The Great Article',
        author: 'John Smith',
        platform: 'Substack',
      }

      const result = await findMatchingContent(item, supabase)
      expect(result).toEqual({ contentItemId: 1, action: 'update' })
    })

    it('does NOT match across kinds — Goodreads book against an existing feed item', async () => {
      // Mock that scopes content_items by the requested kind. The repo
      // contains a feed item with the same title + author the Goodreads CSV
      // is importing. The book import should NOT attach to it (#147).
      const supabase = {
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'content_sources') {
            // No external_id / link match — force fallthrough to Strategy 2/3.
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                  limit: vi.fn().mockResolvedValue({ data: [], error: null }),
                }),
              }),
            }
          }
          if (table === 'content_items') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockImplementation((field: string, value: unknown) => {
                  if (field === 'kind' && value === 'book') {
                    // No books match — kind filter excludes the feed item.
                    return {
                      ilike: vi.fn().mockResolvedValue({ data: [], error: null }),
                    }
                  }
                  // Kind=feed (or other): the same-titled feed item would match here,
                  // but the book importer never asks for kind=feed.
                  return {
                    ilike: vi.fn().mockResolvedValue({
                      data: [{ id: 99, title: 'Atomic Habits', author: 'James Clear' }],
                      error: null,
                    }),
                  }
                }),
              }),
            }
          }
          return { select: vi.fn().mockResolvedValue({ data: [], error: null }) }
        }),
        rpc: vi.fn(),
      } as any
      mockGetAuthorAliases.mockResolvedValue(['james clear'])

      const item: SyncItem = {
        title: 'Atomic Habits',
        author: 'James Clear',
        platform: 'Goodreads',
        kind: 'book',
        externalId: 'goodreads:book:40121378',
      }

      const result = await findMatchingContent(item, supabase)
      expect(result).toBeNull()
    })

    it('matches when titles differ only in quote style', async () => {
      const supabase = createMockSupabase({
        contentItems: [
          { id: 5, title: '\u201CThe Art of War\u201D', author: 'Sun Tzu' },
        ],
      })
      mockGetAuthorAliases.mockResolvedValue(['sun tzu'])

      const item: SyncItem = {
        title: '"The Art of War"',
        author: 'Sun Tzu',
        platform: 'Substack',
      }

      const result = await findMatchingContent(item, supabase)
      expect(result).toEqual({ contentItemId: 5, action: 'update' })
    })

    it('matches when titles differ in dash style', async () => {
      const supabase = createMockSupabase({
        contentItems: [
          { id: 7, title: 'AI Safety \u2014 A Comprehensive Primer', author: 'Researcher' },
        ],
      })
      mockGetAuthorAliases.mockResolvedValue(['researcher'])

      const item: SyncItem = {
        title: 'AI Safety - A Comprehensive Primer',
        author: 'Researcher',
        platform: 'Substack',
      }

      const result = await findMatchingContent(item, supabase)
      expect(result).toEqual({ contentItemId: 7, action: 'update' })
    })

    it('matches via fuzzy match (small typo)', async () => {
      const supabase = createMockSupabase({
        contentItems: [
          { id: 9, title: 'Understanding Machine Learning Today', author: 'Professor' },
        ],
      })
      mockGetAuthorAliases.mockResolvedValue(['professor'])

      const item: SyncItem = {
        // 1 char typo: "Learnng" instead of "Learning"
        title: 'Understanding Machine Learnng Today',
        author: 'Professor',
        platform: 'Substack',
      }

      const result = await findMatchingContent(item, supabase)
      expect(result).toEqual({ contentItemId: 9, action: 'update' })
    })

    it('does not match different titles by same author', async () => {
      const supabase = createMockSupabase({
        contentItems: [
          { id: 1, title: 'Article One', author: 'John' },
          { id: 2, title: 'Article Two', author: 'John' },
        ],
      })
      mockGetAuthorAliases.mockResolvedValue(['john'])

      const item: SyncItem = {
        title: 'Completely Different Article',
        author: 'John',
        platform: 'Substack',
      }

      const result = await findMatchingContent(item, supabase)
      expect(result).toBeNull()
    })

    it('rejects fuzzy match when top two candidates are ambiguous', async () => {
      const supabase = createMockSupabase({
        contentItems: [
          // Both are 1 edit from the incoming title, creating equal-score ambiguity
          { id: 1, title: 'the alignment newsletter edition forty two', author: 'John' },
          { id: 2, title: 'the alignment newsleters edition forty two', author: 'John' },
        ],
      })
      mockGetAuthorAliases.mockResolvedValue(['john'])

      const item: SyncItem = {
        title: 'the alignment newsleter edition forty two',
        author: 'John',
        platform: 'Substack',
      }

      const result = await findMatchingContent(item, supabase)
      expect(result).toBeNull()
    })
  })

  describe('Strategy 4: link-based match (fallback when titles diverge)', () => {
    it('matches by link when strategies 1-3 all fail', async () => {
      // DB has a Spotify-stored title; incoming RSS item has a different title
      // but the same link in content_sources.
      const supabase = createMockSupabase({
        contentItems: [
          { id: 300, title: 'Spotify-side title about something', author: 'Dwarkesh Patel' },
        ],
        sourcesByLink: [
          { id: 99, content_item_id: 300, link: 'https://dwarkesh.substack.com/p/post-a' },
        ],
      })
      mockGetAuthorAliases.mockResolvedValue(['dwarkesh patel'])

      const item: SyncItem = {
        title: 'Blog-side title that is totally different',
        author: 'Dwarkesh Patel',
        platform: 'Substack',
        link: 'https://dwarkesh.substack.com/p/post-a',
      }

      const result = await findMatchingContent(item, supabase)
      expect(result).toEqual({
        contentItemId: 300,
        sourceId: 99,
        action: 'update',
      })
    })

    it('does not fall back to link match when item has no link', async () => {
      const supabase = createMockSupabase({
        contentItems: [],
        sourcesByLink: [
          { id: 99, content_item_id: 300, link: 'https://example.com/post' },
        ],
      })
      mockGetAuthorAliases.mockResolvedValue(['author'])

      const item: SyncItem = {
        title: 'Unique Title',
        author: 'Author',
        platform: 'Substack',
        // no link
      }

      const result = await findMatchingContent(item, supabase)
      expect(result).toBeNull()
      // No externalId and no link → content_sources must not be queried at all.
      expect(supabase.from).not.toHaveBeenCalledWith('content_sources')
    })

    it('does not fall back to link match when item has empty/whitespace link', async () => {
      const supabase = createMockSupabase({
        contentItems: [],
        sourcesByLink: [
          { id: 99, content_item_id: 300, link: '' },
        ],
      })
      mockGetAuthorAliases.mockResolvedValue(['author'])

      const item: SyncItem = {
        title: 'Unique Title',
        author: 'Author',
        platform: 'Substack',
        link: '   ',
      }

      const result = await findMatchingContent(item, supabase)
      expect(result).toBeNull()
      // Whitespace-only link is not a real link — skip strategy 4.
      expect(supabase.from).not.toHaveBeenCalledWith('content_sources')
    })

    it('returns the first row when link matches multiple sources (defensive)', async () => {
      const supabase = createMockSupabase({
        contentItems: [],
        sourcesByLink: [
          { id: 1, content_item_id: 100, link: 'https://example.com/dup' },
          { id: 2, content_item_id: 200, link: 'https://example.com/dup' },
        ],
      })
      mockGetAuthorAliases.mockResolvedValue(['author'])

      const item: SyncItem = {
        title: 'Some Title',
        author: 'Author',
        platform: 'Substack',
        link: 'https://example.com/dup',
      }

      const result = await findMatchingContent(item, supabase)
      // Implementation applies .limit(1), so only the first row is ever returned.
      expect(result).toEqual({
        contentItemId: 100,
        sourceId: 1,
        action: 'update',
      })
    })

    it('falls through to link match when fuzzy title is ambiguous', async () => {
      // Two candidates within the ambiguity margin — title match rejects.
      // Without the fall-through, the RSS item would hit createContent and
      // create a duplicate even though its link already identifies a row.
      const supabase = createMockSupabase({
        contentItems: [
          { id: 1, title: 'the alignment newsletter edition forty two', author: 'John' },
          { id: 2, title: 'the alignment newsleters edition forty two', author: 'John' },
        ],
        sourcesByLink: [
          { id: 42, content_item_id: 1, link: 'https://example.com/p/newsletter-42' },
        ],
      })
      mockGetAuthorAliases.mockResolvedValue(['john'])

      const item: SyncItem = {
        title: 'the alignment newsleter edition forty two',
        author: 'John',
        platform: 'Substack',
        link: 'https://example.com/p/newsletter-42',
      }

      const result = await findMatchingContent(item, supabase)
      expect(result).toEqual({
        contentItemId: 1,
        sourceId: 42,
        action: 'update',
      })
    })

    it('falls through to link match when incoming title normalizes to empty', async () => {
      // A title like '""' (quoted empty) normalizes to ''. Title strategies
      // can't match, but a valid link still identifies the row.
      const supabase = createMockSupabase({
        contentItems: [
          { id: 1, title: 'Real Title', author: 'Author' },
        ],
        sourcesByLink: [
          { id: 99, content_item_id: 1, link: 'https://example.com/p/real' },
        ],
      })
      mockGetAuthorAliases.mockResolvedValue(['author'])

      const item: SyncItem = {
        title: '""',
        author: 'Author',
        platform: 'Substack',
        link: 'https://example.com/p/real',
      }

      const result = await findMatchingContent(item, supabase)
      expect(result).toEqual({
        contentItemId: 1,
        sourceId: 99,
        action: 'update',
      })
    })

    it('trims leading/trailing whitespace from item.link before querying', async () => {
      // Stored links are trimmed; incoming link with stray whitespace
      // (e.g., from an \u00A0 in the feed) should still match.
      const supabase = createMockSupabase({
        contentItems: [],
        sourcesByLink: [
          { id: 7, content_item_id: 500, link: 'https://example.com/post' },
        ],
      })
      mockGetAuthorAliases.mockResolvedValue(['author'])

      const item: SyncItem = {
        title: 'Something Different',
        author: 'Author',
        platform: 'Substack',
        link: '  https://example.com/post  ',
      }

      const result = await findMatchingContent(item, supabase)
      expect(result).toEqual({
        contentItemId: 500,
        sourceId: 7,
        action: 'update',
      })
    })
  })

  describe('Alias-aware title match', () => {
    it('matches via alias author', async () => {
      const supabase = createMockSupabase({
        contentItems: [
          { id: 15, title: 'Deep Dive into Transformers', author: 'Astral Codex Ten' },
        ],
      })
      // Author is "Scott Alexander" but has alias "Astral Codex Ten"
      mockGetAuthorAliases.mockResolvedValue(['scott alexander', 'astral codex ten'])

      // Incoming as "Scott Alexander", existing under alias
      const item: SyncItem = {
        title: 'Deep Dive into Transformers',
        author: 'Scott Alexander',
        platform: 'Substack',
      }

      const result = await findMatchingContent(item, supabase)
      expect(result).toEqual({ contentItemId: 15, action: 'update' })
    })

    it('matches alias with normalized title', async () => {
      const supabase = createMockSupabase({
        contentItems: [
          { id: 20, title: 'Why AI Matters \u2014 A Deep Analysis', author: "Don't Worry About the Vase" },
        ],
      })
      mockGetAuthorAliases.mockResolvedValue(['zvi mowshowitz', "don't worry about the vase"])

      const item: SyncItem = {
        title: 'Why AI Matters - A Deep Analysis',
        author: 'Zvi Mowshowitz',
        platform: 'Substack',
      }

      const result = await findMatchingContent(item, supabase)
      expect(result).toEqual({ contentItemId: 20, action: 'update' })
    })
  })
})

// ---------------------------------------------------------------------------
// ensureRssSource
// ---------------------------------------------------------------------------

interface ExistingRssSource {
  id: number
  link: string
  external_id: string | null
}

function createMockSupabaseForRssSource(existing: ExistingRssSource[] = []) {
  const insertCalls: Array<Record<string, unknown>> = []
  const updateCalls: Array<{ payload: Record<string, unknown>; field: string; value: unknown }> = []
  const queryCalls: Array<{ contentItemId: unknown; platform: unknown }> = []

  const supabase = {
    from: vi.fn().mockImplementation((table: string) => {
      if (table !== 'content_sources') {
        throw new Error(`Unexpected table in ensureRssSource: ${table}`)
      }
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockImplementation((_field1: string, contentItemId: unknown) => ({
            eq: vi.fn().mockImplementation((_field2: string, platform: unknown) => ({
              limit: vi.fn().mockImplementation(() => {
                queryCalls.push({ contentItemId, platform })
                return Promise.resolve({ data: existing, error: null })
              }),
            })),
          })),
        }),
        insert: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          insertCalls.push(payload)
          return Promise.resolve({ error: null })
        }),
        update: vi.fn().mockImplementation((payload: Record<string, unknown>) => ({
          eq: vi.fn().mockImplementation((field: string, value: unknown) => {
            updateCalls.push({ payload, field, value })
            return Promise.resolve({ error: null })
          }),
        })),
      }
    }),
  } as any

  return { supabase, insertCalls, updateCalls, queryCalls }
}

describe('ensureRssSource', () => {
  it('inserts a new row when no source exists for that content + platform', async () => {
    const { supabase, insertCalls, updateCalls } = createMockSupabaseForRssSource([])

    const result = await ensureRssSource(
      42,
      'LessWrong',
      'https://www.lesswrong.com/posts/abc/x',
      undefined,
      supabase
    )

    expect(result).toBe('inserted')
    expect(insertCalls).toHaveLength(1)
    expect(insertCalls[0]).toEqual({
      content_item_id: 42,
      platform: 'LessWrong',
      link: 'https://www.lesswrong.com/posts/abc/x',
      external_id: null,
      is_primary: false,
    })
    expect(updateCalls).toHaveLength(0)
  })

  it('inserts with is_primary=false even when a source for a different platform exists', async () => {
    // Existing array is empty because the query is scoped by platform —
    // a Spotify row for the same content_item_id is filtered out server-side.
    const { supabase, insertCalls, queryCalls } = createMockSupabaseForRssSource([])

    await ensureRssSource(
      100,
      'LessWrong',
      'https://www.lesswrong.com/posts/zzz/post',
      undefined,
      supabase
    )

    expect(queryCalls).toHaveLength(1)
    expect(queryCalls[0]).toEqual({ contentItemId: 100, platform: 'LessWrong' })
    expect(insertCalls).toHaveLength(1)
    expect(insertCalls[0]).toMatchObject({
      content_item_id: 100,
      platform: 'LessWrong',
      is_primary: false,
    })
  })

  it('updates the link when a source exists for same platform with a different link', async () => {
    const { supabase, insertCalls, updateCalls } = createMockSupabaseForRssSource([
      { id: 7, link: 'https://old.example.com/post', external_id: null  },
    ])

    const result = await ensureRssSource(
      42,
      'Substack',
      'https://new.example.com/post',
      undefined,
      supabase
    )

    expect(result).toBe('updated')
    expect(updateCalls).toHaveLength(1)
    // external_id is omitted from the payload when not provided, so an
    // existing non-null external_id is preserved.
    expect(updateCalls[0].payload).toEqual({
      link: 'https://new.example.com/post',
    })
    expect(updateCalls[0].field).toBe('id')
    expect(updateCalls[0].value).toBe(7)
    expect(insertCalls).toHaveLength(0)
  })

  it('preserves existing external_id on link-only update when externalId arg is undefined', async () => {
    const { supabase, updateCalls } = createMockSupabaseForRssSource([
      { id: 7, link: 'https://old.example.com/post', external_id: 'pre-existing-ext-id'  },
    ])

    await ensureRssSource(
      42,
      'Substack',
      'https://new.example.com/post',
      undefined,
      supabase
    )

    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].payload).not.toHaveProperty('external_id')
    expect(updateCalls[0].payload).toEqual({ link: 'https://new.example.com/post' })
  })

  it('writes external_id when explicitly provided (even if null)', async () => {
    const { supabase, updateCalls } = createMockSupabaseForRssSource([
      { id: 7, link: 'https://old.example.com/post', external_id: 'stale-ext-id'  },
    ])

    await ensureRssSource(
      42,
      'Substack',
      'https://new.example.com/post',
      'new-ext-id',
      supabase
    )

    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].payload).toEqual({
      link: 'https://new.example.com/post',
      external_id: 'new-ext-id',
    })
  })

  it('no-ops when a source exists for same platform with the same link', async () => {
    const link = 'https://www.lesswrong.com/posts/abc/x'
    const { supabase, insertCalls, updateCalls } = createMockSupabaseForRssSource([
      { id: 7, link, external_id: null },
    ])

    const result = await ensureRssSource(42, 'LessWrong', link, undefined, supabase)

    expect(result).toBe('unchanged')
    expect(insertCalls).toHaveLength(0)
    expect(updateCalls).toHaveLength(0)
  })

  it('never overwrites a non-empty stored link with an empty one (#207)', async () => {
    const { supabase, insertCalls, updateCalls } = createMockSupabaseForRssSource([
      { id: 7, link: 'https://real.example.com/post', external_id: null  },
    ])

    const result = await ensureRssSource(42, 'Substack', '', undefined, supabase)

    expect(result).toBe('unchanged')
    expect(updateCalls).toHaveLength(0)
    expect(insertCalls).toHaveLength(0)
  })

  it('treats a whitespace-only incoming link as empty (#207)', async () => {
    const { supabase, insertCalls, updateCalls } = createMockSupabaseForRssSource([
      { id: 7, link: 'https://real.example.com/post', external_id: null  },
    ])

    const result = await ensureRssSource(42, 'Substack', '   ', undefined, supabase)

    expect(result).toBe('unchanged')
    expect(updateCalls).toHaveLength(0)
    expect(insertCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// ensureRssSource — error-log redaction (#238 F1)
// A DB error can echo the row's `link`, which for the Askwho Casts path is an
// enclosure URL embedding the feed bearer secret. Error logs must redact it.
// ---------------------------------------------------------------------------

const AWC_ENCLOSURE = 'https://app.askwhocasts.com/f/SECRET123/media/ep.mp3'

function supabaseFailingRssSource(
  where: 'query' | 'insert' | 'update',
  existing: ExistingRssSource[] = [],
  message?: string
) {
  const dbError = { message: message ?? `duplicate key value: ${AWC_ENCLOSURE}` }
  return {
    from: vi.fn().mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({
              data: where === 'query' ? null : existing,
              error: where === 'query' ? dbError : null,
            }),
          }),
        }),
      }),
      insert: vi.fn().mockResolvedValue({ error: where === 'insert' ? dbError : null }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: where === 'update' ? dbError : null }),
      }),
    })),
  } as any
}

describe('ensureRssSource error redaction (#238 F1)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('redacts the link secret from the insert-error log before re-throwing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const supabase = supabaseFailingRssSource('insert', [])

    await expect(
      ensureRssSource(42, 'Askwho Casts', AWC_ENCLOSURE, 'askwhocasts:g', supabase)
    ).rejects.toBeDefined()

    const logged = spy.mock.calls.flat().map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join('\n')
    expect(logged).not.toContain('SECRET123')
    expect(logged).not.toContain(AWC_ENCLOSURE)
  })

  it('redacts the link secret from the update-error log before re-throwing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const supabase = supabaseFailingRssSource('update', [
      { id: 7, link: 'https://app.askwhocasts.com/f/OLD/media/ep.mp3', external_id: null  },
    ])

    await expect(
      ensureRssSource(42, 'Askwho Casts', AWC_ENCLOSURE, 'askwhocasts:g', supabase)
    ).rejects.toBeDefined()

    const logged = spy.mock.calls.flat().map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join('\n')
    expect(logged).not.toContain('SECRET123')
    expect(logged).not.toContain(AWC_ENCLOSURE)
  })

  it('redacts the link secret from the query-error log before re-throwing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const supabase = supabaseFailingRssSource('query')

    await expect(
      ensureRssSource(42, 'Askwho Casts', AWC_ENCLOSURE, 'askwhocasts:g', supabase)
    ).rejects.toBeDefined()

    const logged = spy.mock.calls.flat().map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join('\n')
    expect(logged).not.toContain('SECRET123')
    expect(logged).not.toContain(AWC_ENCLOSURE)
  })

  it('does NOT over-redact a normal (non-AWC) RSS error log — benign path segments survive', async () => {
    // Only Askwho Casts enclosure links embed a bearer secret. A plain article
    // URL like /2024/01/my-post has no secret, so its error must log in full;
    // blanket-redacting path segment '01' would garble legitimate RSS logs.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rssLink = 'https://example.com/2024/01/my-post'
    const supabase = supabaseFailingRssSource(
      'insert',
      [],
      `insert failed for ${rssLink} (segment 01)`
    )

    await expect(
      ensureRssSource(42, 'Substack', rssLink, undefined, supabase)
    ).rejects.toBeDefined()

    const logged = spy.mock.calls.flat().map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join('\n')
    expect(logged).toContain(rssLink)
    expect(logged).toContain('segment 01')
    expect(logged).not.toContain('[feed-secret]')
  })
})

// ---------------------------------------------------------------------------
// createContent — smart-position skip option (#42)
// ---------------------------------------------------------------------------

describe('createContent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Minimal supabase: createContent calls rpc('upsert_content_item'), which
  // RETURNS TABLE(content_id, inserted) → a one-row set, then insertAtSmartPosition
  // (mocked). On a positioning failure it calls rpc('delete_orphan_content_item').
  function supabaseReturningId(id: number) {
    return {
      rpc: vi.fn().mockImplementation((fn: string) => {
        if (fn === 'upsert_content_item') {
          return Promise.resolve({ data: [{ content_id: id, inserted: true }], error: null })
        }
        if (fn === 'delete_orphan_content_item') {
          return Promise.resolve({ data: true, error: null })
        }
        return Promise.resolve({ data: null, error: null })
      }),
    } as any
  }

  const bookItem: SyncItem = {
    title: 'Atomic Habits',
    author: 'James Clear',
    platform: 'Audible',
    link: 'https://www.audible.com/pd/B07XYZ',
    kind: 'book',
    externalId: 'audible:book:B07XYZ',
  }

  it('smart-positions the new item by default', async () => {
    const supabase = supabaseReturningId(999)

    const result = await createContent(bookItem, 'audible', supabase)

    expect(result).toEqual({ contentItemId: 999, inserted: true })
    expect(mockInsertAtSmartPosition).toHaveBeenCalledTimes(1)
  })

  it('skips smart-positioning when skipPositioning is true', async () => {
    const supabase = supabaseReturningId(999)

    const result = await createContent(bookItem, 'audible', supabase, { skipPositioning: true })

    expect(result).toEqual({ contentItemId: 999, inserted: true })
    expect(mockInsertAtSmartPosition).not.toHaveBeenCalled()
  })

  it('skips smart-positioning when the RPC deduped onto an existing row (#176)', async () => {
    // The dedup target may be archived (Completed/Skip) — positioning it would
    // violate the completed_skip_no_position CHECK constraint and 500. A
    // deduped row is either already positioned or deliberately unpositioned;
    // never touch its position.
    const supabase = {
      rpc: vi.fn().mockResolvedValue({
        data: [{ content_id: 1084, inserted: false }],
        error: null,
      }),
    } as any

    const result = await createContent(bookItem, 'audible', supabase)

    expect(result).toEqual({ contentItemId: 1084, inserted: false })
    expect(mockInsertAtSmartPosition).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// createContent — book metadata RPC params (#186)
// ---------------------------------------------------------------------------

describe('createContent — book metadata RPC params (#186)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function supabaseCapturingRpc() {
    return {
      rpc: vi.fn().mockImplementation((fn: string) => {
        if (fn === 'upsert_content_item') {
          return Promise.resolve({ data: [{ content_id: 1, inserted: true }], error: null })
        }
        return Promise.resolve({ data: null, error: null })
      }),
    } as any
  }

  it('threads isbn13/subtitle/series + cover into the upsert_content_item RPC', async () => {
    const supabase = supabaseCapturingRpc()
    const item: SyncItem = {
      title: 'Atomic Habits',
      author: 'James Clear',
      platform: 'Goodreads',
      link: 'https://www.goodreads.com/book/show/40121378-atomic-habits',
      kind: 'book',
      isbn13: '9780735211292',
      subtitle: 'An Easy & Proven Way to Build Good Habits',
      series: 'Dune #1',
      imageUrl: 'https://images.example.com/atomic.jpg',
    }

    await createContent(item, 'tasklet', supabase)

    const call = supabase.rpc.mock.calls.find((c: any[]) => c[0] === 'upsert_content_item')
    expect(call[1]).toEqual(
      expect.objectContaining({
        p_isbn13: '9780735211292',
        p_subtitle: 'An Easy & Proven Way to Build Good Habits',
        p_series: 'Dune #1',
        p_image_url: 'https://images.example.com/atomic.jpg',
      }),
    )
  })

  it('passes null for omitted book-metadata fields (feed back-compat)', async () => {
    const supabase = supabaseCapturingRpc()
    const item: SyncItem = { title: 'X', author: 'Y', platform: 'RSS', kind: 'feed' }

    await createContent(item, 'rss', supabase)

    const call = supabase.rpc.mock.calls.find((c: any[]) => c[0] === 'upsert_content_item')
    expect(call[1]).toEqual(
      expect.objectContaining({ p_isbn13: null, p_subtitle: null, p_series: null }),
    )
  })
})

// ---------------------------------------------------------------------------
// createContent — added_by override (#381)
// ---------------------------------------------------------------------------

describe('createContent — added_by (#381)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function supabaseCapturingRpc() {
    return {
      rpc: vi.fn().mockImplementation((fn: string) => {
        if (fn === 'upsert_content_item') {
          return Promise.resolve({ data: [{ content_id: 1, inserted: true }], error: null })
        }
        return Promise.resolve({ data: null, error: null })
      }),
    } as any
  }

  const item: SyncItem = { title: 'X', author: 'Y', platform: 'Website', link: 'https://example.com/x', kind: 'feed' }

  function upsertParams(supabase: any) {
    return supabase.rpc.mock.calls.find((c: any[]) => c[0] === 'upsert_content_item')[1]
  }

  it('records the sync source as added_by by default', async () => {
    const supabase = supabaseCapturingRpc()
    await createContent(item, 'rss', supabase)
    expect(upsertParams(supabase).p_added_by).toBe('rss')
  })

  it('records the addedBy override instead of the source', async () => {
    const supabase = supabaseCapturingRpc()
    await createContent(item, 'tasklet', supabase, { addedBy: 'Ben' })
    expect(upsertParams(supabase).p_added_by).toBe('Ben')
  })
})

// ---------------------------------------------------------------------------
// createContent — orphan cleanup on positioning failure (#176)
//
// createContent is non-atomic: the RPC commits the new content_items row at
// queue_position=NULL, then insertAtSmartPosition positions it in separate
// calls. If positioning throws, the row is left active (status='') but
// unpositioned — invisible in the queue — and a later add reads it as a
// duplicate (false success). The RPC now returns `inserted` (whether it created
// a brand-new row); on a positioning failure createContent calls
// delete_orphan_content_item ONLY when inserted is true, so it cleans up a
// brand-new orphan but never a pre-existing dedup target. (The orphan-state
// guard + row lock that protect a positioned/in-progress row live inside the
// delete_orphan_content_item RPC — exercised via psql in verify-changes Phase B.)
// ---------------------------------------------------------------------------

describe('createContent — orphan cleanup on positioning failure (#176)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const item: SyncItem = {
    title: 'New Post',
    author: 'Author',
    platform: 'Substack',
    link: 'https://example.substack.com/p/new',
    manuallyRequested: true,
    kind: 'feed',
  }

  const NEW_ID = 555

  // Supabase mock keyed on RPC name: insert_or_update_content returns one row
  // with a controllable `inserted` flag; delete_orphan_content_item records the
  // id it was called with.
  function makeSupabase(opts: { inserted: boolean }) {
    const cleanupCalls: number[] = []
    const supabase = {
      rpc: vi.fn().mockImplementation((fn: string, args: { p_id?: number }) => {
        if (fn === 'upsert_content_item') {
          return Promise.resolve({ data: [{ content_id: NEW_ID, inserted: opts.inserted }], error: null })
        }
        if (fn === 'delete_orphan_content_item') {
          cleanupCalls.push(args.p_id as number)
          return Promise.resolve({ data: true, error: null })
        }
        return Promise.resolve({ data: null, error: null })
      }),
    } as any
    return { supabase, cleanupCalls }
  }

  it('cleans up the orphan when positioning fails on a newly-inserted row', async () => {
    mockInsertAtSmartPosition.mockRejectedValueOnce(new Error('shift failed'))
    const { supabase, cleanupCalls } = makeSupabase({ inserted: true })

    await expect(createContent(item, 'tasklet', supabase)).rejects.toThrow('shift failed')

    expect(cleanupCalls).toEqual([NEW_ID])
  })

  it('never positions (so never cleans up) when the RPC deduped onto an existing row', async () => {
    const { supabase, cleanupCalls } = makeSupabase({ inserted: false })

    const result = await createContent(item, 'tasklet', supabase)

    expect(result).toEqual({ contentItemId: NEW_ID, inserted: false })
    expect(mockInsertAtSmartPosition).not.toHaveBeenCalled()
    expect(cleanupCalls).toHaveLength(0)
  })

  it('does not clean up anything on the happy path', async () => {
    mockInsertAtSmartPosition.mockResolvedValueOnce(2)
    const { supabase, cleanupCalls } = makeSupabase({ inserted: true })

    const result = await createContent(item, 'tasklet', supabase)

    expect(result).toEqual({ contentItemId: NEW_ID, inserted: true })
    expect(cleanupCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// readInsertResult — parse the upsert_content_item TABLE result (#176)
// ---------------------------------------------------------------------------

describe('readInsertResult', () => {
  it('reads the (content_id, inserted) one-row set', () => {
    expect(readInsertResult([{ content_id: 42, inserted: true }])).toEqual({
      contentId: 42,
      inserted: true,
    })
    expect(readInsertResult([{ content_id: 7, inserted: false }])).toEqual({
      contentId: 7,
      inserted: false,
    })
  })

  it('throws on an empty or unexpected shape', () => {
    expect(() => readInsertResult([])).toThrow()
    expect(() => readInsertResult(null)).toThrow()
    expect(() => readInsertResult(99)).toThrow()
    expect(() => readInsertResult({ content_id: 1 })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// findMatchingContent — book base-title match (#42)
//
// Audible sends *base* titles ("Manufacturing Consent") while Goodreads stores
// *full* titles with ": subtitle" or " (Series, #N)" suffixes. Exact and fuzzy
// matching miss these (the suffix is far more than the fuzzy edit budget), so a
// duplicate book is created. A book-scoped base-title strategy merges them.
// ---------------------------------------------------------------------------

describe('findMatchingContent — book base-title match (#42)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockGetAuthorAliases.mockResolvedValue([])
  })

  it('merges an Audible base title into a Goodreads row carrying a ": subtitle"', async () => {
    const supabase = createMockSupabase({
      contentItems: [
        { id: 7, title: 'Manufacturing Consent: The Political Economy of the Mass Media', author: 'Edward S. Herman' },
      ],
    })

    const item: SyncItem = {
      title: 'Manufacturing Consent',
      author: 'Edward S. Herman',
      platform: 'Audible',
      kind: 'book',
      externalId: 'audible:book:B06Y2J6MQZ',
      link: 'https://www.audible.com/pd/B06Y2J6MQZ',
    }

    const result = await findMatchingContent(item, supabase)
    expect(result).toEqual({ contentItemId: 7, action: 'update' })
  })

  it('merges an Audible base title into a Goodreads row carrying a " (Series, #N)" suffix', async () => {
    const supabase = createMockSupabase({
      contentItems: [
        { id: 11, title: 'Children of Time (Children of Time, #1)', author: 'Adrian Tchaikovsky' },
      ],
    })

    const item: SyncItem = {
      title: 'Children of Time',
      author: 'Adrian Tchaikovsky',
      platform: 'Audible',
      kind: 'book',
      externalId: 'audible:book:B0FAKEASIN',
    }

    const result = await findMatchingContent(item, supabase)
    expect(result).toEqual({ contentItemId: 11, action: 'update' })
  })

  it('does NOT base-match when two candidates share the base title (ambiguous)', async () => {
    const supabase = createMockSupabase({
      contentItems: [
        { id: 1, title: 'Dune: Part One', author: 'Frank Herbert' },
        { id: 2, title: 'Dune: Part Two', author: 'Frank Herbert' },
      ],
    })

    const item: SyncItem = {
      title: 'Dune',
      author: 'Frank Herbert',
      platform: 'Audible',
      kind: 'book',
      externalId: 'audible:book:B0AMBIGUOUS',
    }

    const result = await findMatchingContent(item, supabase)
    expect(result).toBeNull()
  })

  it('does NOT base-match for feed items (book-only strategy)', async () => {
    const supabase = createMockSupabase({
      contentItems: [
        { id: 3, title: 'Manufacturing Consent: The Political Economy of the Mass Media', author: 'Some Author' },
      ],
    })

    const item: SyncItem = {
      // No kind → defaults to 'feed'. The subtitle-divergence merge must not
      // fire for feeds (battle-tested feed matching stays exact/fuzzy/link only).
      title: 'Manufacturing Consent',
      author: 'Some Author',
      platform: 'Substack',
    }

    const result = await findMatchingContent(item, supabase)
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// shouldAutoAdd
// ---------------------------------------------------------------------------

describe('shouldAutoAdd', () => {
  it('returns false for substack — the progress harvester is update-only (#192)', () => {
    expect(shouldAutoAdd('substack')).toBe(false)
  })

  it('returns true for every other source', () => {
    const sources: SyncSource[] = ['spotify', 'audible', 'elevenreader', 'tasklet', 'rss', 'goodreads']
    for (const source of sources) {
      expect(shouldAutoAdd(source)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// backfillExternalId (#192)
// ---------------------------------------------------------------------------

interface BackfillExistingSource {
  id: number
  external_id: string | null
}

function createMockSupabaseForBackfill(options: {
  existing?: BackfillExistingSource[]
  insertError?: { code?: string; message?: string } | null
  updateError?: { code?: string; message?: string } | null
}) {
  const { existing = [], insertError = null, updateError = null } = options
  const insertCalls: Array<Record<string, unknown>> = []
  const updateCalls: Array<{ payload: Record<string, unknown>; field: string; value: unknown }> = []

  const supabase = {
    from: vi.fn().mockImplementation((table: string) => {
      if (table !== 'content_sources') {
        throw new Error(`Unexpected table in backfillExternalId: ${table}`)
      }
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({ data: existing, error: null }),
            }),
          }),
        }),
        insert: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          insertCalls.push(payload)
          return Promise.resolve({ error: insertError })
        }),
        update: vi.fn().mockImplementation((payload: Record<string, unknown>) => ({
          eq: vi.fn().mockImplementation((field: string, value: unknown) => {
            updateCalls.push({ payload, field, value })
            return Promise.resolve({ error: updateError })
          }),
        })),
      }
    }),
  } as any

  return { supabase, insertCalls, updateCalls }
}

describe('backfillExternalId (#192)', () => {
  it('sets external_id on an existing source whose external_id is NULL — link untouched', async () => {
    const { supabase, insertCalls, updateCalls } = createMockSupabaseForBackfill({
      existing: [{ id: 7, external_id: null }],
    })

    const result = await backfillExternalId(
      50, 'Substack', 'https://pub.substack.com/p/slug', 'substack:post:123', supabase
    )

    expect(result).toBe('set')
    expect(insertCalls).toHaveLength(0)
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].payload).toEqual({ external_id: 'substack:post:123' })
    expect(updateCalls[0].field).toBe('id')
    expect(updateCalls[0].value).toBe(7)
  })

  it('is a no-op when the source already has that external_id', async () => {
    const { supabase, insertCalls, updateCalls } = createMockSupabaseForBackfill({
      existing: [{ id: 7, external_id: 'substack:post:123' }],
    })

    const result = await backfillExternalId(
      50, 'Substack', 'https://pub.substack.com/p/slug', 'substack:post:123', supabase
    )

    expect(result).toBe('unchanged')
    expect(insertCalls).toHaveLength(0)
    expect(updateCalls).toHaveLength(0)
  })

  it('never clobbers a DIFFERENT existing external_id', async () => {
    const { supabase, insertCalls, updateCalls } = createMockSupabaseForBackfill({
      existing: [{ id: 7, external_id: 'substack:post:999' }],
    })

    const result = await backfillExternalId(
      50, 'Substack', 'https://pub.substack.com/p/slug', 'substack:post:123', supabase
    )

    expect(result).toBe('unchanged')
    expect(updateCalls).toHaveLength(0)
  })

  it('inserts a non-primary source when no source exists for that platform', async () => {
    const { supabase, insertCalls } = createMockSupabaseForBackfill({ existing: [] })

    const result = await backfillExternalId(
      50, 'Substack', 'https://pub.substack.com/p/slug', 'substack:post:123', supabase
    )

    expect(result).toBe('inserted')
    expect(insertCalls).toHaveLength(1)
    expect(insertCalls[0]).toEqual({
      content_item_id: 50,
      platform: 'Substack',
      link: 'https://pub.substack.com/p/slug',
      external_id: 'substack:post:123',
      is_primary: false,
    })
  })

  it('tolerates 23505 on insert (external_id already attached elsewhere)', async () => {
    const { supabase } = createMockSupabaseForBackfill({
      existing: [],
      insertError: { code: '23505', message: 'duplicate key' },
    })

    await expect(
      backfillExternalId(50, 'Substack', 'https://x.com/p/s', 'substack:post:123', supabase)
    ).resolves.toBe('unchanged')
  })

  it('tolerates 23505 on update (external_id already attached elsewhere)', async () => {
    const { supabase } = createMockSupabaseForBackfill({
      existing: [{ id: 7, external_id: null }],
      updateError: { code: '23505', message: 'duplicate key' },
    })

    await expect(
      backfillExternalId(50, 'Substack', 'https://x.com/p/s', 'substack:post:123', supabase)
    ).resolves.toBe('unchanged')
  })

  it('throws on non-23505 errors', async () => {
    const { supabase } = createMockSupabaseForBackfill({
      existing: [],
      insertError: { code: '42P01', message: 'boom' },
    })

    await expect(
      backfillExternalId(50, 'Substack', 'https://x.com/p/s', 'substack:post:123', supabase)
    ).rejects.toMatchObject({ code: '42P01' })
  })
})

// ---------------------------------------------------------------------------
// updateContentProgress — atomic skipArchived guard (#192 review fix)
// ---------------------------------------------------------------------------

describe('updateContentProgress — guarded persistence (#266)', () => {
  it.each([false, true])('passes the archived guard (%s) to the atomic RPC', async (skipArchived) => {
    const rpc = vi.fn().mockResolvedValue({ error: null })
    await updateContentProgress(50, '63', 'In Progress', { rpc } as any, { skipArchived })
    expect(rpc).toHaveBeenCalledWith('apply_content_progress', {
      p_item_id: 50, p_progress: '63', p_status: 'In Progress', p_skip_archived: skipArchived,
    })
  })
  it('routes Spotify to its source-aware policy', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null })
    await updateContentProgress(50, '96', 'Completed', { rpc } as any, { source: 'spotify' })
    expect(rpc).toHaveBeenCalledWith('apply_spotify_progress', {
      updates: [{ id: 50, progress: '96', status: 'Completed', source: 'spotify' }],
    })
  })
  it('propagates persistence errors', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: new Error('write failed') })
    await expect(updateContentProgress(50, '96', 'Completed', { rpc } as any)).rejects.toThrow('write failed')
  })
})

// ---------------------------------------------------------------------------
// updateSourceProgress (#194)
// ---------------------------------------------------------------------------

describe('updateSourceProgress (#194)', () => {
  function createSourceProgressMock(result: { error: unknown } = { error: null }) {
    const calls: { payload?: Record<string, unknown>; eqs: Array<[string, unknown]> } = { eqs: [] }
    const chain: Record<string, unknown> = {}
    chain.update = vi.fn((payload: Record<string, unknown>) => {
      calls.payload = payload
      return chain
    })
    chain.eq = vi.fn((field: string, value: unknown) => {
      calls.eqs.push([field, value])
      // The real call is `update().eq('content_item_id', …).eq('platform', …)`
      // awaited as a thenable — resolve on the second filter.
      return calls.eqs.length === 2 ? Promise.resolve(result) : chain
    })
    const from = vi.fn(() => chain)
    const supabase = { from } as unknown as SupabaseClient
    return { supabase, calls, from }
  }

  it('writes the parsed percent filtered by content_item_id + platform', async () => {
    const { supabase, calls, from } = createSourceProgressMock()

    await updateSourceProgress(50, 'Substack', '55', supabase)

    expect(from).toHaveBeenCalledWith('content_sources')
    expect(calls.payload).toEqual({ progress: 55 })
    expect(calls.eqs).toEqual([
      ['content_item_id', 50],
      ['platform', 'Substack'],
    ])
  })

  it('writes a REGRESSION — last-seen semantics, not high-water', async () => {
    // The caller passes whatever the platform reported; there is no guard.
    const { supabase, calls } = createSourceProgressMock()

    await updateSourceProgress(50, 'Spotify', '10', supabase)

    expect(calls.payload).toEqual({ progress: 10 })
  })

  it('is a no-op when normalized progress is null', async () => {
    const { supabase, from } = createSourceProgressMock()

    await updateSourceProgress(50, 'Substack', null, supabase)

    expect(from).not.toHaveBeenCalled()
  })

  it('swallows DB errors (best-effort enrichment, never fails the sync item)', async () => {
    const { supabase } = createSourceProgressMock({ error: { message: 'boom' } })

    await expect(updateSourceProgress(50, 'Substack', '55', supabase)).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// ensureSpotifySourceFromCache — external_id-aware multi-episode support (#237)
// ---------------------------------------------------------------------------

function createSpotifySourceMock(
  options: {
    insertError?: { code: string; message: string }
    updateError?: { code: string; message: string }
  } = {}
) {
  const neq = vi.fn().mockResolvedValue({ error: null })
  // update().eq() is awaited directly on the adoption path and chained with
  // .neq() on the demote path — return a promise carrying the .neq method.
  const updateEq = vi.fn().mockImplementation(() =>
    Object.assign(Promise.resolve({ error: options.updateError ?? null }), { neq })
  )
  const update = vi.fn().mockReturnValue({ eq: updateEq })
  // insert() is awaited directly on the alongside path and chained with
  // .select().single() on the primary path.
  const insert = vi.fn().mockImplementation(() =>
    Object.assign(Promise.resolve({ error: options.insertError ?? null }), {
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({
          data: options.insertError ? null : { id: 99 },
          error: options.insertError ?? null,
        }),
      }),
    })
  )
  const supabase = {
    from: vi.fn().mockReturnValue({ update, insert }),
  } as any
  return { supabase, update, updateEq, neq, insert }
}

describe('ensureSpotifySourceFromCache multi-episode (#237)', () => {
  it('updates only the row with the same external_id when the link changes', async () => {
    const { supabase, update, updateEq, insert } = createSpotifySourceMock()
    await ensureSpotifySourceFromCache(
      1,
      'https://open.spotify.com/episode/NEW',
      'spotify:episode:A',
      [
        { id: 10, link: 'https://open.spotify.com/episode/OLD', external_id: 'spotify:episode:A' , progress: null, source_label: null },
        { id: 11, link: 'https://open.spotify.com/episode/other', external_id: 'spotify:episode:B' , progress: null, source_label: null },
      ],
      supabase
    )
    expect(update).toHaveBeenCalledWith({
      link: 'https://open.spotify.com/episode/NEW',
      external_id: 'spotify:episode:A',
      source_label: null,
    })
    expect(updateEq).toHaveBeenCalledWith('id', 10)
    expect(insert).not.toHaveBeenCalled()
  })

  it('is a no-op when the same episode row already matches', async () => {
    const { supabase, update, insert } = createSpotifySourceMock()
    await ensureSpotifySourceFromCache(
      1,
      'https://open.spotify.com/episode/X',
      'spotify:episode:X',
      [{ id: 10, link: 'https://open.spotify.com/episode/X', external_id: 'spotify:episode:X' , progress: null, source_label: null }],
      supabase
    )
    expect(update).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
  })

  it('inserts an additional non-primary row when the item has other-episode rows (flip-flop regression)', async () => {
    const { supabase, update, insert } = createSpotifySourceMock()
    await ensureSpotifySourceFromCache(
      1,
      'https://open.spotify.com/episode/askwho',
      'spotify:episode:ASKWHO',
      [{ id: 10, link: 'https://open.spotify.com/episode/human', external_id: 'spotify:episode:HUMAN' , progress: null, source_label: null }],
      supabase
    )
    expect(update).not.toHaveBeenCalled() // the human-narrated row is untouched
    expect(insert).toHaveBeenCalledWith({
      content_item_id: 1,
      platform: 'Spotify',
      link: 'https://open.spotify.com/episode/askwho',
      external_id: 'spotify:episode:ASKWHO',
      is_primary: false,
      source_label: null,
    })
  })

  it('adopts a legacy null-external_id row with the same link (backfills external_id)', async () => {
    const { supabase, update, updateEq, insert } = createSpotifySourceMock()
    await ensureSpotifySourceFromCache(
      1,
      'https://open.spotify.com/episode/X',
      'spotify:episode:X',
      [{ id: 10, link: 'https://open.spotify.com/episode/X', external_id: null , progress: null, source_label: null }],
      supabase
    )
    expect(update).toHaveBeenCalledWith({
      link: 'https://open.spotify.com/episode/X',
      external_id: 'spotify:episode:X',
      source_label: null,
    })
    expect(updateEq).toHaveBeenCalledWith('id', 10)
    expect(insert).not.toHaveBeenCalled()
  })

  it('inserts the primary row first, then demotes only the other rows, when no Spotify rows exist', async () => {
    const { supabase, update, updateEq, neq, insert } = createSpotifySourceMock()
    await ensureSpotifySourceFromCache(
      1,
      'https://open.spotify.com/episode/X',
      'spotify:episode:X',
      [],
      supabase
    )
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ is_primary: true, external_id: 'spotify:episode:X' })
    )
    expect(update).toHaveBeenCalledWith({ is_primary: false })
    expect(updateEq).toHaveBeenCalledWith('content_item_id', 1)
    expect(neq).toHaveBeenCalledWith('id', 99)
  })

  it('does not demote any primaries when the primary insert loses a 23505 race', async () => {
    const { supabase, update } = createSpotifySourceMock({
      insertError: { code: '23505', message: 'duplicate' },
    })
    await expect(
      ensureSpotifySourceFromCache(1, 'https://open.spotify.com/episode/X', 'spotify:episode:X', [], supabase)
    ).resolves.toBeUndefined()
    expect(update).not.toHaveBeenCalled()
  })

  it('tolerates a 23505 race on legacy-row adoption as a no-op', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { supabase } = createSpotifySourceMock({
        updateError: { code: '23505', message: 'duplicate' },
      })
      await expect(
        ensureSpotifySourceFromCache(
          1,
          'https://open.spotify.com/episode/X',
          'spotify:episode:X',
          [{ id: 10, link: 'https://open.spotify.com/episode/X', external_id: null , progress: null, source_label: null }],
          supabase
        )
      ).resolves.toBeUndefined()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('treats a 23505 insert race as a no-op', async () => {
    const { supabase } = createSpotifySourceMock({ insertError: { code: '23505', message: 'duplicate' } })
    await expect(
      ensureSpotifySourceFromCache(
        1,
        'https://open.spotify.com/episode/X',
        'spotify:episode:X',
        [{ id: 10, link: 'https://open.spotify.com/episode/other', external_id: 'spotify:episode:OTHER' , progress: null, source_label: null }],
        supabase
      )
    ).resolves.toBeUndefined()
  })
})

describe('ensureSpotifySourceFromCache source_label (#245)', () => {
  it('writes the show name on the primary insert when no Spotify rows exist', async () => {
    const { supabase, insert } = createSpotifySourceMock()
    await ensureSpotifySourceFromCache(
      1,
      'https://open.spotify.com/episode/X',
      'spotify:episode:X',
      [],
      supabase,
      'Astral Codex Ten Podcast',
    )
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ is_primary: true, source_label: 'Astral Codex Ten Podcast' }),
    )
  })

  it('writes the show name on the alongside insert (second Spotify episode)', async () => {
    const { supabase, insert } = createSpotifySourceMock()
    await ensureSpotifySourceFromCache(
      1,
      'https://open.spotify.com/episode/askwho',
      'spotify:episode:ASKWHO',
      [{ id: 10, link: 'https://open.spotify.com/episode/human', external_id: 'spotify:episode:HUMAN', progress: null, source_label: 'Astral Codex Ten Podcast' }],
      supabase,
      'AI Article Readings',
    )
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ is_primary: false, source_label: 'AI Article Readings' }),
    )
  })

  it('backfills the label on an existing same-episode row that has none', async () => {
    const { supabase, update, updateEq } = createSpotifySourceMock()
    await ensureSpotifySourceFromCache(
      1,
      'https://open.spotify.com/episode/X',
      'spotify:episode:X',
      [{ id: 10, link: 'https://open.spotify.com/episode/X', external_id: 'spotify:episode:X', progress: null, source_label: null }],
      supabase,
      'AI Article Readings',
    )
    // link + external_id already match, but the label was missing — must update.
    expect(update).toHaveBeenCalledWith({
      link: 'https://open.spotify.com/episode/X',
      external_id: 'spotify:episode:X',
      source_label: 'AI Article Readings',
    })
    expect(updateEq).toHaveBeenCalledWith('id', 10)
  })

  it('is a no-op when link, external_id AND label all already match', async () => {
    const { supabase, update, insert } = createSpotifySourceMock()
    await ensureSpotifySourceFromCache(
      1,
      'https://open.spotify.com/episode/X',
      'spotify:episode:X',
      [{ id: 10, link: 'https://open.spotify.com/episode/X', external_id: 'spotify:episode:X', progress: null, source_label: 'AI Article Readings' }],
      supabase,
      'AI Article Readings',
    )
    expect(update).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// apple_podcasts source (#322)
// ---------------------------------------------------------------------------

describe('apple_podcasts source (#322)', () => {
  it('never auto-adds — the Apple Podcasts harvester is update-only', () => {
    expect(shouldAutoAdd('apple_podcasts')).toBe(false)
  })

  it('routes apple_podcasts through the Spotify listening rules', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null })
    await updateContentProgress(7, '100', 'Completed', { rpc } as any, { source: 'apple_podcasts' })
    expect(rpc).toHaveBeenCalledWith('apply_spotify_progress', {
      updates: [{ id: 7, progress: '100', status: 'Completed' }],
    })
  })

  it('usesListeningRules is true only for listening sources', () => {
    expect(usesListeningRules('spotify')).toBe(true)
    expect(usesListeningRules('apple_podcasts')).toBe(true)
    expect(usesListeningRules('substack')).toBe(false)
    expect(usesListeningRules(undefined)).toBe(false)
  })
})

describe('findByExternalId (#322)', () => {
  it('returns the matching source row', async () => {
    const supabase = createMockSupabase({ sources: [{ id: 10, content_item_id: 42 }] })
    expect(await findByExternalId('askwhocasts:abc', supabase)).toEqual({
      contentItemId: 42,
      sourceId: 10,
      action: 'update',
    })
  })

  it('returns null without a match when externalId is missing', async () => {
    const supabase = createMockSupabase({ sources: [{ id: 10, content_item_id: 42 }] })
    expect(await findByExternalId(undefined, supabase)).toBeNull()
  })
})

describe('updateSourceProgress — exact source row (#322 review)', () => {
  it('writes by source id when given, so a sibling same-platform row is untouched', async () => {
    const eqs: Array<[string, unknown]> = []
    let payload: unknown
    const chain = {
      update: vi.fn((p: unknown) => {
        payload = p
        return chain
      }),
      eq: vi.fn((field: string, value: unknown) => {
        eqs.push([field, value])
        return Promise.resolve({ error: null })
      }),
    }
    const supabase = { from: vi.fn(() => chain) } as unknown as SupabaseClient

    await updateSourceProgress(50, 'Askwho Casts', '40', supabase, 77)

    expect(payload).toEqual({ progress: 40 })
    expect(eqs).toEqual([['id', 77]])
  })
})

describe('ensureRssSource with sourceLabel (#368)', () => {
  function labelled(rows: Array<{ id: number; link: string; external_id: string | null }>) {
    const filters: unknown[][] = []
    const insert = vi.fn().mockResolvedValue({ error: null })
    const updateEq = vi.fn().mockResolvedValue({ error: null })
    const update = vi.fn().mockReturnValue({ eq: updateEq })
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'is']) chain[m] = vi.fn((...args: unknown[]) => { filters.push([m, ...args]); return chain })
    chain.limit = vi.fn().mockResolvedValue({ data: rows, error: null })
    const supabase = { from: vi.fn(() => ({ ...chain, insert, update })) } as unknown as SupabaseClient
    return { supabase, filters, insert, update }
  }

  it('looks up and writes the labelled row', async () => {
    const { supabase, filters, insert } = labelled([])
    await ensureRssSource(7, 'Askwho Casts', 'https://x/c.mp3', 'askwhocasts:c', supabase, { sourceLabel: 'Comments' })
    expect(filters).toContainEqual(['eq', 'source_label', 'Comments'])
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ source_label: 'Comments' }))
  })
  it('limits an article lookup to unlabelled rows, so it cannot overwrite a comments episode', async () => {
    const { supabase, filters, insert } = labelled([])
    await ensureRssSource(7, 'Askwho Casts', 'https://x/a.mp3', 'askwhocasts:a', supabase, { sourceLabel: null })
    expect(filters).toContainEqual(['is', 'source_label', null])
    expect(insert.mock.calls[0][0]).not.toHaveProperty('source_label')
  })
  it('does not filter on the label without the option', async () => {
    const { supabase, filters } = labelled([])
    await ensureRssSource(7, 'LessWrong', 'https://x/p', undefined, supabase)
    expect(filters.some(([, field]) => field === 'source_label')).toBe(false)
  })
})

describe('findByExternalId sourceLabel (#368)', () => {
  it('returns the label of the matched source', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { id: 5, content_item_id: 7, source_label: 'Comments' }, error: null })
    const select = vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle }) })
    const supabase = { from: vi.fn().mockReturnValue({ select }) } as unknown as SupabaseClient
    expect(await findByExternalId('askwhocasts:c', supabase)).toEqual({ contentItemId: 7, sourceId: 5, sourceLabel: 'Comments', action: 'update' })
  })
})

describe('completeAwaitingComments (#368)', () => {
  function client(error: unknown = null) {
    const calls: unknown[][] = []
    const chain: Record<string, unknown> = {}
    chain.update = vi.fn((payload: unknown) => { calls.push(['update', payload]); return chain })
    chain.eq = vi.fn((...args: unknown[]) => { calls.push(['eq', ...args]); return chain })
    ;(chain as { then: unknown }).then = (f: (v: unknown) => unknown) => Promise.resolve({ error }).then(f)
    return { supabase: { from: vi.fn(() => chain) } as unknown as SupabaseClient, calls }
  }
  it('completes the card only while it is Awaiting comments, leaving the queue slot as Done does', async () => {
    const { supabase, calls } = client()
    await completeAwaitingComments(7, supabase)
    expect(calls).toContainEqual(['eq', 'id', 7])
    expect(calls).toContainEqual(['eq', 'status', 'Awaiting comments'])
    expect(calls[0][1]).toMatchObject({ status: 'Completed', queue_position: null, position_confirmed: false })
    expect((calls[0][1] as { status_changed_at: string }).status_changed_at).toEqual(expect.any(String))
  })
  it('throws a write failure so the sync run reports it', async () => {
    await expect(completeAwaitingComments(7, client({ message: 'x' }).supabase)).rejects.toEqual({ message: 'x' })
  })
})
