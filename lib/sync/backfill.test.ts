import { describe, it, expect, vi, beforeEach } from 'vitest'

// backfill.ts is a thin orchestrator over the matching primitives (already
// tested in matching.test.ts). Mock those so these tests assert the
// orchestration: windowing, sorting, the ambiguity guard, create-vs-attach
// routing, and dry-run gating. normalizeTitle stays real (pure).
vi.mock('@/lib/sync/matching', () => ({
  findMatchingContent: vi.fn(),
  createContent: vi.fn(),
  ensureRssSource: vi.fn(),
}))

import { findMatchingContent, createContent, ensureRssSource } from '@/lib/sync/matching'
import { classifyFeedPosts, applyBackfillSelection, type BackfillPost } from './backfill'

const mockFind = vi.mocked(findMatchingContent)
const mockCreate = vi.mocked(createContent)
const mockEnsure = vi.mocked(ensureRssSource)

// Dummy client — never touched directly (matching fns are mocked).
const supabase = {} as never

const NOW = new Date('2026-05-25T12:00:00Z')

/** Build a parsed post N days before NOW. */
function post(daysAgo: number, overrides: Partial<BackfillPost> = {}): BackfillPost {
  const d = new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000)
  const publishedOn = d.toISOString().slice(0, 10)
  return {
    title: `Post ${daysAgo}d ago`,
    author: 'Test Author',
    platform: 'Substack',
    link: `https://example.com/p/${daysAgo}`,
    publishedOn,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: nothing matches (every post is "missing").
  mockFind.mockResolvedValue(null)
})

describe('classifyFeedPosts', () => {
  it('filters to the window, sorts newest→oldest, and flags matched vs missing', async () => {
    mockFind.mockImplementation(async (item) => {
      if (item.link === 'https://example.com/p/10') {
        return { contentItemId: 5, action: 'update' }
      }
      return null
    })

    const posts = [
      post(30), // missing, in window
      post(10), // matched, in window
      post(200), // out of window — excluded
    ]

    const result = await classifyFeedPosts(posts, supabase, { windowDays: 90, now: NOW })

    expect(result.map((r) => r.item.link)).toEqual([
      'https://example.com/p/10', // newest first
      'https://example.com/p/30',
    ])
    expect(result[0]).toMatchObject({ status: 'matched', contentItemId: 5 })
    expect(result[1]).toMatchObject({ status: 'missing' })
  })

  it('flags posts whose normalized title collides with another in-window post as ambiguous', async () => {
    const posts = [
      post(5, { title: 'Same Title', link: 'https://example.com/a' }),
      post(8, { title: 'Same Title', link: 'https://example.com/b' }),
      post(12, { title: 'Unique Title', link: 'https://example.com/c' }),
    ]

    const result = await classifyFeedPosts(posts, supabase, { windowDays: 90, now: NOW })

    const byLink = Object.fromEntries(result.map((r) => [r.item.link, r.status]))
    expect(byLink['https://example.com/a']).toBe('ambiguous')
    expect(byLink['https://example.com/b']).toBe('ambiguous')
    expect(byLink['https://example.com/c']).toBe('missing')
  })

  it('flags a no-link post sharing a title with a linked post as ambiguous (#207)', async () => {
    const posts = [
      post(5, { title: 'Same Title', link: undefined }),
      post(8, { title: 'Same Title', link: 'https://example.com/b' }),
    ]

    const result = await classifyFeedPosts(posts, supabase, { windowDays: 90, now: NOW })

    expect(result.map((r) => r.status)).toEqual(['ambiguous', 'ambiguous'])
  })

  it('does not flag two no-link posts with the same title as ambiguous', async () => {
    // Indistinguishable no-link posts are treated as the same post seen twice,
    // mirroring the same-title/same-link rule.
    const posts = [
      post(5, { title: 'Same Title', link: undefined }),
      post(8, { title: 'Same Title', link: undefined }),
    ]

    const result = await classifyFeedPosts(posts, supabase, { windowDays: 90, now: NOW })

    expect(result.every((r) => r.status === 'missing')).toBe(true)
  })
})

describe('applyBackfillSelection', () => {
  it('dry-run plans actions without any writes', async () => {
    mockFind.mockImplementation(async (item) =>
      item.link === 'https://example.com/p/3' ? { contentItemId: 7, action: 'update' } : null
    )

    const result = await applyBackfillSelection([post(3), post(6)], supabase, { dryRun: true })

    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockEnsure).not.toHaveBeenCalled()
    const byLink = Object.fromEntries(result.map((r) => [r.item.link, r.action]))
    expect(byLink['https://example.com/p/3']).toBe('source-attached') // matched
    expect(byLink['https://example.com/p/6']).toBe('created') // missing
  })

  it('creates a content_item for a missing post', async () => {
    mockFind.mockResolvedValue(null)
    mockCreate.mockResolvedValue({ contentItemId: 101, inserted: true })

    const p = post(6)
    const result = await applyBackfillSelection([p], supabase, { dryRun: false })

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ link: p.link }), 'rss', supabase)
    expect(mockEnsure).not.toHaveBeenCalled()
    expect(result[0]).toMatchObject({ action: 'created', contentItemId: 101 })
  })

  it('attaches the feed source to a post that already matches, without creating', async () => {
    mockFind.mockResolvedValue({ contentItemId: 7, action: 'update' })
    mockEnsure.mockResolvedValue('inserted')

    const p = post(4, { platform: 'Substack' })
    const result = await applyBackfillSelection([p], supabase, { dryRun: false })

    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockEnsure).toHaveBeenCalledWith(7, 'Substack', p.link, undefined, supabase)
    expect(result[0]).toMatchObject({ action: 'source-attached', contentItemId: 7 })
  })

  it('is idempotent: a re-run over an already-present post creates nothing', async () => {
    mockFind.mockResolvedValue({ contentItemId: 7, action: 'update' })
    mockEnsure.mockResolvedValue('unchanged')

    const result = await applyBackfillSelection([post(4)], supabase, { dryRun: false })

    expect(mockCreate).not.toHaveBeenCalled()
    expect(result[0]).toMatchObject({ action: 'unchanged', contentItemId: 7 })
  })

  it('never attaches a source for a matched no-link post (#207)', async () => {
    // Pre-#207 this called ensureRssSource(7, ..., '') which overwrote the
    // item's real source link with '' — reported as a benign source-attach.
    mockFind.mockResolvedValue({ contentItemId: 7, action: 'update' })

    const result = await applyBackfillSelection(
      [post(4, { link: undefined })],
      supabase,
      { dryRun: false }
    )

    expect(mockEnsure).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
    expect(result[0]).toMatchObject({ action: 'unchanged', contentItemId: 7 })
  })

  it('dry-run reports a matched no-link post as unchanged (#207)', async () => {
    mockFind.mockResolvedValue({ contentItemId: 7, action: 'update' })

    const result = await applyBackfillSelection(
      [post(4, { link: undefined })],
      supabase,
      { dryRun: true }
    )

    expect(mockEnsure).not.toHaveBeenCalled()
    expect(result[0]).toMatchObject({ action: 'unchanged', contentItemId: 7 })
  })

  it('skips a no-link post sharing a title with a linked post as ambiguous (#207)', async () => {
    const result = await applyBackfillSelection(
      [
        post(5, { title: 'Same Title', link: undefined }),
        post(8, { title: 'Same Title', link: 'https://example.com/b' }),
      ],
      supabase,
      { dryRun: false }
    )

    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockEnsure).not.toHaveBeenCalled()
    expect(result.every((r) => r.action === 'skipped-ambiguous')).toBe(true)
  })

  it('skips ambiguous duplicate-title posts within the selection', async () => {
    const result = await applyBackfillSelection(
      [
        post(5, { title: 'Same Title', link: 'https://example.com/a' }),
        post(8, { title: 'Same Title', link: 'https://example.com/b' }),
      ],
      supabase,
      { dryRun: false }
    )

    expect(mockCreate).not.toHaveBeenCalled()
    expect(result.every((r) => r.action === 'skipped-ambiguous')).toBe(true)
  })
})
