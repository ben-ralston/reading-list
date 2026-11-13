import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFrom = vi.fn()
vi.mock('@/lib/supabase', () => ({
  supabase: { from: (...a: unknown[]) => mockFrom(...a) },
}))

import { listFeeds, insertFeed, updateFeed, recordFeedError } from './feeds-repo'

const ROW = {
  id: 1, url: 'https://x.substack.com/feed', label: 'X', author_name: 'X',
  platform: 'Substack', feed_type: 'substack', active: true, source: 'manual',
  created_at: 't', updated_at: 't', last_fetched_at: null, last_success_at: null,
  last_error: null, last_error_at: null, last_item_count: null, consecutive_errors: 0,
}

beforeEach(() => mockFrom.mockReset())

describe('listFeeds', () => {
  it('returns only active feeds by default, mapped to camelCase', async () => {
    const eq = vi.fn().mockResolvedValue({ data: [ROW], error: null })
    const order = vi.fn().mockReturnValue({ eq })
    const select = vi.fn().mockReturnValue({ order })
    mockFrom.mockReturnValue({ select })

    const feeds = await listFeeds()

    expect(mockFrom).toHaveBeenCalledWith('rss_feeds')
    expect(eq).toHaveBeenCalledWith('active', true)
    expect(feeds[0]).toMatchObject({ id: 1, feedType: 'substack', authorName: 'X', consecutiveErrors: 0, source: 'manual' })
  })

  it('includes disabled feeds when asked (no active filter)', async () => {
    // When includeDisabled is true, the query (the order(...) result) is
    // awaited directly without ever chaining .eq('active', true).
    const eq = vi.fn()
    const queryResult = Promise.resolve({ data: [ROW], error: null })
    ;(queryResult as unknown as { eq: unknown }).eq = eq
    const order = vi.fn().mockReturnValue(queryResult)
    const select = vi.fn().mockReturnValue({ order })
    mockFrom.mockReturnValue({ select })

    const feeds = await listFeeds({ includeDisabled: true })

    expect(eq).not.toHaveBeenCalled()
    expect(feeds).toHaveLength(1)
  })

  it('throws on a Supabase error', async () => {
    const eq = vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } })
    const order = vi.fn().mockReturnValue({ eq })
    mockFrom.mockReturnValue({ select: vi.fn().mockReturnValue({ order }) })
    await expect(listFeeds()).rejects.toThrow('boom')
  })
})

describe('insertFeed', () => {
  it('maps camelCase input to snake_case, defaulting source to manual', async () => {
    const single = vi.fn().mockResolvedValue({ data: { ...ROW, id: 7 }, error: null })
    const select = vi.fn().mockReturnValue({ single })
    const insert = vi.fn().mockReturnValue({ select })
    mockFrom.mockReturnValue({ insert })

    const feed = await insertFeed({
      url: 'https://x.substack.com/feed', label: 'X', authorName: 'X',
      platform: 'Substack', feedType: 'substack',
    })

    expect(insert).toHaveBeenCalledWith({
      url: 'https://x.substack.com/feed', label: 'X', author_name: 'X',
      platform: 'Substack', feed_type: 'substack', source: 'manual',
    })
    expect(feed.id).toBe(7)
  })

  it('passes an explicit source through to the insert', async () => {
    const single = vi.fn().mockResolvedValue({ data: { ...ROW, id: 8, source: 'substack_auto' }, error: null })
    const select = vi.fn().mockReturnValue({ single })
    const insert = vi.fn().mockReturnValue({ select })
    mockFrom.mockReturnValue({ insert })

    const feed = await insertFeed({
      url: 'https://y.substack.com/feed', label: 'Y', authorName: 'Y',
      platform: 'Substack', feedType: 'substack', source: 'substack_auto',
    })

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ source: 'substack_auto' }))
    expect(feed.source).toBe('substack_auto')
  })
})

describe('updateFeed', () => {
  it('only sends keys present in the patch and returns the mapped feed', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { ...ROW, active: false }, error: null })
    const select = vi.fn().mockReturnValue({ maybeSingle })
    const eq = vi.fn().mockReturnValue({ select })
    const update = vi.fn().mockReturnValue({ eq })
    mockFrom.mockReturnValue({ update })

    const feed = await updateFeed(5, { active: false })

    expect(update).toHaveBeenCalledWith({ active: false })
    expect(eq).toHaveBeenCalledWith('id', 5)
    expect(feed).toMatchObject({ id: 1, active: false, feedType: 'substack' })
  })

  it('returns null when no row matched the id', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
    const select = vi.fn().mockReturnValue({ maybeSingle })
    const eq = vi.fn().mockReturnValue({ select })
    const update = vi.fn().mockReturnValue({ eq })
    mockFrom.mockReturnValue({ update })

    expect(await updateFeed(999, { label: 'Nope' })).toBeNull()
  })
})

describe('recordFeedError', () => {
  it('reads current count, increments it, and sets error fields', async () => {
    // First supabase.from(...) call: the SELECT consecutive_errors read.
    const maybeSingle = vi.fn().mockResolvedValue({ data: { consecutive_errors: 0 } })
    const selEq = vi.fn().mockReturnValue({ maybeSingle })
    const sel = vi.fn().mockReturnValue({ eq: selEq })
    // Second supabase.from(...) call: the UPDATE.
    const updEq = vi.fn().mockResolvedValue({ error: null })
    const update = vi.fn().mockReturnValue({ eq: updEq })
    mockFrom
      .mockReturnValueOnce({ select: sel })
      .mockReturnValueOnce({ update })

    await recordFeedError(3, 'TimeoutError: dead')

    const patch = update.mock.calls[0][0]
    expect(patch.last_error).toBe('TimeoutError: dead')
    expect(patch.consecutive_errors).toBe(1)
    expect(patch.last_success_at).toBeUndefined()
    expect(updEq).toHaveBeenCalledWith('id', 3)
  })

  it('advances last_success_at when advanceCutoff is set (guard skip, #287)', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { consecutive_errors: 0 } })
    const selEq = vi.fn().mockReturnValue({ maybeSingle })
    const sel = vi.fn().mockReturnValue({ eq: selEq })
    const updEq = vi.fn().mockResolvedValue({ error: null })
    const update = vi.fn().mockReturnValue({ eq: updEq })
    mockFrom
      .mockReturnValueOnce({ select: sel })
      .mockReturnValueOnce({ update })

    await recordFeedError(3, '978 items past cutoff', { advanceCutoff: true })

    const patch = update.mock.calls[0][0]
    expect(patch.last_error).toBe('978 items past cutoff')
    expect(patch.consecutive_errors).toBe(1)
    expect(typeof patch.last_success_at).toBe('string')
    expect(patch.last_success_at).toBe(patch.last_fetched_at)
  })
})
