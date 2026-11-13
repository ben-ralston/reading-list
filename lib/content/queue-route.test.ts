import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock Supabase before importing the module under test.
const mockFrom = vi.fn()
const mockRpc = vi.fn()
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}))

// Don't actually invalidate the cache during tests.
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

vi.mock('@/lib/awc/conversions-repo', () => ({ requestConversion: vi.fn(), getActiveForItem: vi.fn() }))
import { requestConversion, getActiveForItem } from '@/lib/awc/conversions-repo'

import {
  fetchActiveItems,
  fetchFeedHome,
  handleQueueGet,
  handleQueuePost,
  handleArchiveGet,
  type QueueRouteConfig,
} from './queue-route'

const FEED_CONFIG: QueueRouteConfig = {
  kind: 'feed',
  revalidatePaths: ['/'],
  logPrefix: '[FeedTest]',
}

const BOOKS_CONFIG: QueueRouteConfig = {
  kind: 'book',
  revalidatePaths: ['/books'],
  logPrefix: '[BooksTest]',
}

// Builds a chainable mock that records every method call so a test can
// assert how the route filtered + ordered the query.
function makeChain(finalResult: { data?: unknown; error?: unknown }) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const chain: Record<string, unknown> = {}
  const record = (method: string) =>
    vi.fn((...args: unknown[]) => {
      calls.push({ method, args })
      return chain
    })
  Object.assign(chain, {
    select: record('select'),
    insert: record('insert'),
    update: record('update'),
    eq: record('eq'),
    gte: record('gte'),
    neq: record('neq'),
    in: record('in'),
    or: record('or'),
    order: record('order'),
    range: record('range'),
    limit: record('limit'),
    single: vi.fn().mockResolvedValue(finalResult),
    maybeSingle: vi.fn().mockResolvedValue(finalResult),
    then: undefined,
    // The route awaits the query directly (no .single()) for list selects.
    // Adding `then` makes the chain thenable so `await chain` resolves to finalResult.
  })
  // Make chain awaitable for list-style selects.
  ;(chain as unknown as PromiseLike<unknown>).then = (onfulfilled?: (v: unknown) => unknown) =>
    Promise.resolve(finalResult).then(onfulfilled)
  return { chain, calls }
}

function eqArgsFor(calls: Array<{ method: string; args: unknown[] }>): unknown[][] {
  return calls.filter((c) => c.method === 'eq').map((c) => c.args)
}

beforeEach(() => {
  vi.resetAllMocks()
  // Ensure mock-data short-circuit doesn't fire during these tests.
  delete process.env.USE_MOCK_DATA
})

describe('handleQueueGet', () => {
  it('filters by kind=feed for the feed route', async () => {
    const { chain, calls } = makeChain({ data: [], error: null })
    mockFrom.mockReturnValue(chain)

    const res = await handleQueueGet(FEED_CONFIG)
    expect(res.status).toBe(200)

    expect(mockFrom).toHaveBeenCalledWith('content_items')
    expect(eqArgsFor(calls)).toContainEqual(['kind', 'feed'])
  })

  it('filters by kind=book for the books route', async () => {
    const { chain, calls } = makeChain({ data: [], error: null })
    mockFrom.mockReturnValue(chain)

    const res = await handleQueueGet(BOOKS_CONFIG)
    expect(res.status).toBe(200)

    expect(eqArgsFor(calls)).toContainEqual(['kind', 'book'])
    // And not 'feed'.
    expect(eqArgsFor(calls)).not.toContainEqual(['kind', 'feed'])
  })

  it('returns 500 on supabase error', async () => {
    const { chain } = makeChain({ data: null, error: { message: 'boom' } })
    mockFrom.mockReturnValue(chain)

    const res = await handleQueueGet(FEED_CONFIG)
    expect(res.status).toBe(500)
  })

  // RLV-003 (#189 follow-up): the response must not be edge-cacheable. A public
  // s-maxage let the Vercel CDN serve a pre-mutation queue for 30-90s even after
  // the pages were made force-dynamic, re-introducing the completed-item-lingers bug.
  it('marks the queue response non-cacheable (no shared/edge caching)', async () => {
    const { chain } = makeChain({ data: [], error: null })
    mockFrom.mockReturnValue(chain)

    const res = await handleQueueGet(FEED_CONFIG)
    const cacheControl = res.headers.get('Cache-Control') ?? ''
    expect(cacheControl).not.toMatch(/s-maxage/)
    expect(cacheControl).toMatch(/no-store/)
  })

  // #255: queue responses carry author engagement so the client-side
  // Recommended sort has its interest signal.
  describe('engagement attachment (#255)', () => {
    const itemRow = {
      id: 1,
      title: 'Test',
      author: 'Jane Doe',
      published_on: null,
      status: '',
      queue_position: null,
      position_confirmed: false,
      progress: null,
      added_by: null,
      created_at: '2026-08-01T00:00:00Z',
      updated_at: '2026-08-01T00:00:00Z',
      status_changed_at: null,
      summary: null,
      summary_generated_at: null,
      kind: 'feed',
      sources: [],
    }

    it('attaches engagementScore from the author_engagement_scores view', async () => {
      const itemsChain = makeChain({ data: [itemRow], error: null })
      const engagementChain = makeChain({
        data: [{ canonical_author: 'jane doe', aliases: ['jane doe'], engagement_score: 0.4 }],
        error: null,
      })
      mockFrom.mockImplementation((table: string) =>
        table === 'author_engagement_scores' ? engagementChain.chain : itemsChain.chain,
      )

      const res = await handleQueueGet(FEED_CONFIG)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.items[0].engagementScore).toBe(0.4)
    })

    it('fails open to null scores when the view query errors', async () => {
      const itemsChain = makeChain({ data: [itemRow], error: null })
      const engagementChain = makeChain({ data: null, error: { message: 'view gone' } })
      mockFrom.mockImplementation((table: string) =>
        table === 'author_engagement_scores' ? engagementChain.chain : itemsChain.chain,
      )

      const res = await handleQueueGet(FEED_CONFIG)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.items[0].engagementScore).toBeNull()
    })
  })
})

describe('fetchActiveItems pagination (#377)', () => {
  const row = (id: number) => ({
    id, title: `T${id}`, author: 'A', published_on: null, status: '', queue_position: null,
    position_confirmed: false, progress: null, added_by: null, created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z', status_changed_at: null, kind: 'feed', sources: [],
  })

  it('pages past 1,000 rows with a stable id tiebreaker', async () => {
    const pages = [Array.from({ length: 1000 }, (_, i) => row(i + 1)), [row(1001), row(1002), row(1003)]]
    const ranges: unknown[][] = []
    const orders: unknown[][] = []
    const itemsChain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'neq']) itemsChain[m] = vi.fn(() => itemsChain)
    itemsChain.order = vi.fn((...args: unknown[]) => { orders.push(args); return itemsChain })
    itemsChain.range = vi.fn((...args: unknown[]) => {
      ranges.push(args)
      const data = pages[ranges.length - 1] ?? []
      return Promise.resolve({ data, error: null })
    })
    const engagement = makeChain({ data: [], error: null })
    mockFrom.mockImplementation((table: string) =>
      table === 'author_engagement_scores' ? engagement.chain : itemsChain,
    )

    const items = await fetchActiveItems('feed')
    expect(items).toHaveLength(1003)
    expect(ranges).toEqual([[0, 999], [1000, 1999]])
    expect(orders[orders.length - 1]).toEqual(['id', { ascending: true }])
  })

  it('pages the feed by id alone, so concurrent position shifts cannot move rows between pages', async () => {
    const orders: unknown[][] = []
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'neq']) chain[m] = vi.fn(() => chain)
    chain.order = vi.fn((...args: unknown[]) => { orders.push(args); return chain })
    chain.range = vi.fn(() => Promise.resolve({ data: [], error: null }))
    const engagement = makeChain({ data: [], error: null })
    mockFrom.mockImplementation((table: string) => (table === 'author_engagement_scores' ? engagement.chain : chain))
    await fetchActiveItems('feed')
    expect(orders).toEqual([['id', { ascending: true }]])
    orders.length = 0
    await fetchActiveItems('book')
    expect(orders[0]).toEqual(['queue_position', { ascending: true, nullsFirst: false }])
  })
})

describe('GET envelope (#377)', () => {
  it('feed GET returns { items, curation }', async () => {
    const items = makeChain({ data: [], error: null })
    const runs = makeChain({ data: { finished_at: '2026-11-09T21:45:00Z', picks: [] }, error: null })
    mockFrom.mockImplementation((table: string) => (table === 'curation_runs' ? runs.chain : items.chain))
    const res = await handleQueueGet(FEED_CONFIG)
    expect(await res.json()).toEqual({ items: [], curation: { finishedAt: '2026-11-09T21:45:00Z', picks: [] } })
  })

  it('books GET still returns a plain array', async () => {
    const { chain } = makeChain({ data: [], error: null })
    mockFrom.mockReturnValue(chain)
    const res = await handleQueueGet(BOOKS_CONFIG)
    expect(await res.json()).toEqual([])
    expect(mockFrom).not.toHaveBeenCalledWith('curation_runs')
  })

  it('feed mock mode returns the envelope with no curation', async () => {
    process.env.USE_MOCK_DATA = 'true'
    vi.resetModules()
    const mod = await import('./queue-route')
    const res = await mod.handleQueueGet({ ...FEED_CONFIG, mockData: [] })
    expect(await res.json()).toEqual({ items: [], curation: null })
    delete process.env.USE_MOCK_DATA
  })
})

describe('fetchFeedHome (#377)', () => {
  it('returns items with curation null when curation_runs errors', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const items = makeChain({ data: [], error: null })
    const engagement = makeChain({ data: [], error: null })
    const runs = makeChain({ data: null, error: { message: 'boom' } })
    mockFrom.mockImplementation((table: string) =>
      table === 'author_engagement_scores' ? engagement.chain
        : table === 'curation_runs' ? runs.chain
          : items.chain,
    )
    expect(await fetchFeedHome()).toEqual({ items: [], curation: null })
    spy.mockRestore()
  })

  it('returns the latest succeeded picks alongside the items', async () => {
    const items = makeChain({ data: [], error: null })
    const engagement = makeChain({ data: [], error: null })
    const runs = makeChain({ data: { finished_at: '2026-11-09T21:45:00Z', picks: [{ id: 3, reason: null }] }, error: null })
    mockFrom.mockImplementation((table: string) =>
      table === 'author_engagement_scores' ? engagement.chain
        : table === 'curation_runs' ? runs.chain
          : items.chain,
    )
    expect((await fetchFeedHome()).curation).toEqual({ finishedAt: '2026-11-09T21:45:00Z', picks: [{ id: 3, reason: null }] })
  })
})

describe('handleArchiveGet', () => {
  it('filters by kind=feed for the feed archive', async () => {
    const { chain, calls } = makeChain({ data: [], error: null })
    mockFrom.mockReturnValue(chain)

    await handleArchiveGet(FEED_CONFIG)
    expect(eqArgsFor(calls)).toContainEqual(['kind', 'feed'])
  })

  it('filters by kind=book for the books archive', async () => {
    const { chain, calls } = makeChain({ data: [], error: null })
    mockFrom.mockReturnValue(chain)

    await handleArchiveGet(BOOKS_CONFIG)
    expect(eqArgsFor(calls)).toContainEqual(['kind', 'book'])
  })
})

// #232: PostgREST silently caps responses at 1000 rows. The archive (1063
// feed rows and growing) must page with .range() until a short page, or the
// oldest items silently vanish from the archive view.
describe('handleArchiveGet pagination (#232)', () => {
  function archiveRow(id: number) {
    return { id, title: `Item ${id}`, author: 'A', sources: [], kind: 'feed', status: 'Completed' }
  }

  function rangeArgsFor(calls: Array<{ method: string; args: unknown[] }>): unknown[][] {
    return calls.filter((c) => c.method === 'range').map((c) => c.args)
  }

  it('pages past the 1000-row cap and returns every archive row', async () => {
    const page1 = makeChain({
      data: Array.from({ length: 1000 }, (_, i) => archiveRow(i + 1)),
      error: null,
    })
    const page2 = makeChain({
      data: Array.from({ length: 63 }, (_, i) => archiveRow(1001 + i)),
      error: null,
    })
    mockFrom
      .mockImplementationOnce(() => page1.chain)
      .mockImplementationOnce(() => page2.chain)

    const res = await handleArchiveGet(FEED_CONFIG)
    expect(res.status).toBe(200)

    const items = (await res.json()) as Array<{ id: number }>
    expect(items).toHaveLength(1063)
    expect(items[0].id).toBe(1)
    expect(items[1062].id).toBe(1063)

    // The second (short) page ends the loop — exactly two queries.
    expect(mockFrom).toHaveBeenCalledTimes(2)
    expect(rangeArgsFor(page1.calls)).toContainEqual([0, 999])
    expect(rangeArgsFor(page2.calls)).toContainEqual([1000, 1999])
  })

  // The regression the issue asks for: a result of exactly the cap must not be
  // treated as "the whole archive" — the route has to look for a next page.
  it('fetches a follow-up page when a query returns exactly the cap', async () => {
    const page1 = makeChain({
      data: Array.from({ length: 1000 }, (_, i) => archiveRow(i + 1)),
      error: null,
    })
    const page2 = makeChain({ data: [], error: null })
    mockFrom
      .mockImplementationOnce(() => page1.chain)
      .mockImplementationOnce(() => page2.chain)

    const res = await handleArchiveGet(FEED_CONFIG)
    expect(res.status).toBe(200)
    expect((await res.json()) as unknown[]).toHaveLength(1000)
    expect(mockFrom).toHaveBeenCalledTimes(2)
  })
})

describe('pin / dismiss / feed makeNext and restore (#377)', () => {
  const feedRow = { id: 7, title: 'X', author: 'Y', sources: [], kind: 'feed', pinned_at: '2026-11-09T12:00:00Z' }
  const post = (body: unknown, config = FEED_CONFIG) =>
    handleQueuePost(new Request('http://localhost/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }), config)
  const updateOf = (calls: Array<{ method: string; args: unknown[] }>) =>
    calls.find((c) => c.method === 'update')?.args[0] as Record<string, unknown>

  it('pin sets pinned_at and clears the dismissal on an active feed row', async () => {
    const { chain, calls } = makeChain({ data: feedRow, error: null })
    mockFrom.mockReturnValue(chain)
    const res = await post({ action: 'pin', id: 7 })
    expect(res.status).toBe(200)
    expect((await res.json()).pinnedAt).toBe('2026-11-09T12:00:00Z')
    expect(updateOf(calls)).toMatchObject({ shortlist_dismissed_at: null })
    expect(eqArgsFor(calls)).toContainEqual(['kind', 'feed'])
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('pin on an item that is no longer active returns 409', async () => {
    const { chain } = makeChain({ data: null, error: null })
    mockFrom.mockReturnValue(chain)
    const res = await post({ action: 'pin', id: 7 })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('Item is no longer in the queue')
  })

  it('dismiss clears pinned_at and sets shortlist_dismissed_at', async () => {
    const { chain, calls } = makeChain({ data: { ...feedRow, pinned_at: null }, error: null })
    mockFrom.mockReturnValue(chain)
    const res = await post({ action: 'dismiss', id: 7 })
    expect(res.status).toBe(200)
    const update = updateOf(calls)
    expect(update.pinned_at).toBeNull()
    expect(typeof update.shortlist_dismissed_at).toBe('string')
  })

  it('dismiss on an archived item returns 409', async () => {
    const { chain } = makeChain({ data: null, error: null })
    mockFrom.mockReturnValue(chain)
    expect((await post({ action: 'dismiss', id: 7 })).status).toBe(409)
  })

  it.each(['pin', 'dismiss'])('%s on the books route returns 400 and writes nothing', async (action) => {
    const res = await post({ action, id: 7 }, BOOKS_CONFIG)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Only feed items can be pinned')
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('feed makeNext pins and never calls place_item_in_queue', async () => {
    const { chain, calls } = makeChain({ data: feedRow, error: null })
    mockFrom.mockReturnValue(chain)
    const res = await post({ action: 'makeNext', id: 7 })
    expect(res.status).toBe(200)
    expect(typeof updateOf(calls).pinned_at).toBe('string')
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('books makeNext still places the book at position 1 via the RPC', async () => {
    mockFrom
      .mockImplementationOnce(() => makeChain({ data: { id: 8 }, error: null }).chain)
      .mockImplementationOnce(() => makeChain({ data: { id: 8, title: 'B', author: 'Y', sources: [], kind: 'book' }, error: null }).chain)
    mockRpc.mockResolvedValue({ error: null })
    const res = await post({ action: 'makeNext', id: 8 }, BOOKS_CONFIG)
    expect(res.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('place_item_in_queue', {
      p_item_id: 8, p_kind: 'book', p_target_position: 1, p_position_confirmed: true,
    })
  })

  it('feed restoreItem reactivates, marks Restored and pins, with no RPC', async () => {
    const { chain, calls } = makeChain({ data: feedRow, error: null })
    mockFrom.mockReturnValue(chain)
    const res = await post({ action: 'restoreItem', id: 7 })
    expect(res.status).toBe(200)
    expect(updateOf(calls)).toMatchObject({ status: '', added_by: 'Restored', queue_position: null })
    expect(calls).toContainEqual({ method: 'in', args: ['status', ['Completed', 'Skip']] })
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('feed restoreItem on an item that is not archived returns 400', async () => {
    const { chain } = makeChain({ data: null, error: null })
    mockFrom.mockReturnValue(chain)
    const res = await post({ action: 'restoreItem', id: 7 })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Item not found in this queue')
  })
})

describe('handleQueuePost / restoreItem', () => {
  // RLV-004 (#203): restore must be one atomic RPC (shift + place in a single
  // transaction), not a JS-side read→shift→write that races concurrent inserts.
  it('restores via the place_item_in_queue RPC, kind-scoped', async () => {
    // First call: pre-check that the target item is the right kind.
    const preCheckChain = makeChain({ data: { id: 42 }, error: null })
    // Second call: re-SELECT the restored row for the response payload.
    const selectChain = makeChain({
      data: { id: 42, title: 'X', author: 'Y', sources: [], kind: 'book' },
      error: null,
    })

    mockFrom
      .mockImplementationOnce(() => preCheckChain.chain)
      .mockImplementationOnce(() => selectChain.chain)
    mockRpc.mockResolvedValue({ error: null })

    const req = new Request('http://localhost/api/books', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'restoreItem', id: 42 }),
    })

    const res = await handleQueuePost(req, BOOKS_CONFIG)
    expect(res.status).toBe(200)

    expect(mockRpc).toHaveBeenCalledWith('place_item_in_queue', {
      p_item_id: 42,
      p_kind: 'book',
      p_target_position: null,
      p_target_rank: 2,
      p_position_confirmed: false,
      p_restore: true,
    })
    // Kind-touching reads filter by 'book'.
    expect(eqArgsFor(preCheckChain.calls)).toContainEqual(['kind', 'book'])
    expect(eqArgsFor(selectChain.calls)).toContainEqual(['kind', 'book'])
  })

  it('rejects restoreItem when the target id belongs to the other kind', async () => {
    // Pre-check returns no row because id=42 is a feed item, not a book.
    const preCheckChain = makeChain({ data: null, error: null })
    mockFrom.mockImplementationOnce(() => preCheckChain.chain)

    const req = new Request('http://localhost/api/books', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'restoreItem', id: 42 }),
    })

    const res = await handleQueuePost(req, BOOKS_CONFIG)
    expect(res.status).toBe(400)
    // No placement RPC ran.
    expect(mockFrom).toHaveBeenCalledTimes(1)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('chains kind filter on single-row updateStatus', async () => {
    const updateChain = makeChain({
      data: { id: 7, title: 'X', author: 'Y', sources: [], kind: 'feed' },
      error: null,
    })
    mockFrom.mockImplementationOnce(() => updateChain.chain)

    const req = new Request('http://localhost/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'updateStatus', id: 7, status: 'Completed' }),
    })

    const res = await handleQueuePost(req, FEED_CONFIG)
    expect(res.status).toBe(200)
    expect(eqArgsFor(updateChain.calls)).toContainEqual(['kind', 'feed'])
  })

  it('markSentToReader sets sent_to_reader_at, kind-scoped (#171)', async () => {
    const updateChain = makeChain({
      data: {
        id: 7,
        title: 'X',
        author: 'Y',
        sources: [],
        kind: 'feed',
        sent_to_reader_at: '2026-06-06T00:00:00Z',
      },
      error: null,
    })
    mockFrom.mockImplementationOnce(() => updateChain.chain)

    const req = new Request('http://localhost/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'markSentToReader', id: 7 }),
    })

    const res = await handleQueuePost(req, FEED_CONFIG)
    expect(res.status).toBe(200)
    const updateArgs = updateChain.calls.find((c) => c.method === 'update')?.args[0] as
      | Record<string, unknown>
      | undefined
    expect(updateArgs).toBeDefined()
    expect(typeof updateArgs!.sent_to_reader_at).toBe('string')
    expect(eqArgsFor(updateChain.calls)).toContainEqual(['kind', 'feed'])
  })

  it('rejects a batchUpdate when any id belongs to the other kind', async () => {
    // Pre-check returns only 1 row even though 2 ids were sent → mismatch.
    const preCheckChain = makeChain({ data: [{ id: 1 }], error: null })
    mockFrom.mockImplementationOnce(() => preCheckChain.chain)

    const req = new Request('http://localhost/api/books', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'batchUpdate',
        updates: [
          { id: 1, queuePosition: 1 },
          { id: 2, queuePosition: 2 },
        ],
      }),
    })

    const res = await handleQueuePost(req, BOOKS_CONFIG)
    expect(res.status).toBe(400)
    // Pre-check ran but the RPC was never called.
    expect(mockRpc).not.toHaveBeenCalled()
    expect(eqArgsFor(preCheckChain.calls)).toContainEqual(['kind', 'book'])
  })

  // RLV-022 (#203): a payload containing the same id twice is valid (the RPC
  // applies entries sequentially, last write wins). The ownership check must
  // compare against unique ids — the #147 incident 400'd here misleadingly.
  it('accepts a batchUpdate containing duplicate ids', async () => {
    const preCheckChain = makeChain({ data: [{ id: 1 }], error: null })
    mockFrom.mockImplementationOnce(() => preCheckChain.chain)
    mockRpc.mockResolvedValue({ error: null })

    const req = new Request('http://localhost/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'batchUpdate',
        updates: [
          { id: 1, queuePosition: 2 },
          { id: 1, queuePosition: 3 },
        ],
      }),
    })

    const res = await handleQueuePost(req, FEED_CONFIG)
    expect(res.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  // RLV-022 (#203): a batch entry that completes/skips an item must null its
  // queue_position (and drop position_confirmed) server-side, mirroring
  // updateStatus — otherwise the completed_skip_no_position CHECK 500s the
  // whole batch.
  it('force-nulls queue_position when a batch entry completes or skips', async () => {
    const preCheckChain = makeChain({ data: [{ id: 1 }, { id: 2 }], error: null })
    mockFrom.mockImplementationOnce(() => preCheckChain.chain)
    mockRpc.mockResolvedValue({ error: null })

    const req = new Request('http://localhost/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'batchUpdate',
        updates: [
          { id: 1, status: 'Completed' },
          { id: 2, status: 'Skip', queuePosition: 5 },
        ],
      }),
    })

    const res = await handleQueuePost(req, FEED_CONFIG)
    expect(res.status).toBe(200)

    const rpcArgs = mockRpc.mock.calls[0] as [string, { updates: Record<string, unknown>[] }]
    expect(rpcArgs[0]).toBe('batch_update_content_items')
    expect(rpcArgs[1].updates[0]).toMatchObject({
      id: 1,
      status: 'Completed',
      queue_position: null,
      position_confirmed: false,
    })
    // Even an explicit queuePosition is overridden when the entry skips.
    expect(rpcArgs[1].updates[1]).toMatchObject({
      id: 2,
      status: 'Skip',
      queue_position: null,
      position_confirmed: false,
    })
  })

  it('rejects missing id for non-batchUpdate actions', async () => {
    const req = new Request('http://localhost/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'updateStatus', status: 'Completed' }),
    })

    const res = await handleQueuePost(req, FEED_CONFIG)
    expect(res.status).toBe(400)
  })

  // #233: updatePosition was an unguarded single-row queue_position write with
  // no callers — exactly the write shape that minted duplicate positions
  // (#229). The action is removed; it must now fall through to 400.
  it('rejects the removed updatePosition action', async () => {
    const req = new Request('http://localhost/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'updatePosition', id: 7, queuePosition: 3 }),
    })

    const res = await handleQueuePost(req, FEED_CONFIG)
    expect(res.status).toBe(400)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects unknown actions', async () => {
    const req = new Request('http://localhost/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'doSomethingWeird', id: 1 }),
    })

    const res = await handleQueuePost(req, FEED_CONFIG)
    expect(res.status).toBe(400)
  })
})

it.each(['', 'In Progress'])('preserves Awaiting comments when a stale page submits %j', async (status) => {
  const update = makeChain({ data: null, error: null })
  const current = makeChain({ data: { id: 7, title: 'X', author: 'Y', sources: [], kind: 'feed', status: 'Awaiting comments' }, error: null })
  mockFrom.mockImplementationOnce(() => update.chain).mockImplementationOnce(() => current.chain)
  const response = await handleQueuePost(new Request('http://localhost/api/queue', {
    method: 'POST', body: JSON.stringify({ action: 'updateStatus', id: 7, status }),
  }), FEED_CONFIG)
  expect(response.status).toBe(200)
  expect((await response.json()).status).toBe('Awaiting comments')
  expect(update.calls).toContainEqual({ method: 'neq', args: ['status', 'Awaiting comments'] })
  expect(eqArgsFor(current.calls)).toContainEqual(['kind', 'feed'])
})

describe('requestAwcConversion action (#317)', () => {
  const post = (body: unknown, config = FEED_CONFIG) =>
    handleQueuePost(new Request('http://x/api/queue', { method: 'POST', body: JSON.stringify(body) }), config)
  const feedRow = (overrides: Record<string, unknown> = {}) => ({
    id: 5, title: 'T', author: 'A', kind: 'feed', status: '', queue_position: 1, position_confirmed: true,
    sources: [{ id: 1, platform: 'Substack', link: 'https://ex.com/p', message_id: null, is_primary: true, created_at: 'c', source_label: null }],
    ...overrides,
  })

  it('queues a conversion for an eligible feed item', async () => {
    const { chain } = makeChain({ data: feedRow(), error: null })
    mockFrom.mockReturnValue(chain)
    vi.mocked(requestConversion).mockResolvedValue({ ok: true, conversion: { id: 9, status: 'queued', error: null, requestedAt: 'r', updatedAt: 'u' } })
    const res = await post({ action: 'requestAwcConversion', id: 5 })
    expect(res.status).toBe(200)
    expect(requestConversion).toHaveBeenCalledWith(expect.anything(), 5, 'https://ex.com/p')
    expect((await res.json()).status).toBe('queued')
  })

  it('409s with the existing active conversion so the client can track it', async () => {
    mockFrom.mockReturnValue(makeChain({ data: feedRow(), error: null }).chain)
    vi.mocked(requestConversion).mockResolvedValue({ ok: false, reason: 'already_active' })
    const existing = { id: 7, status: 'building_script' as const, error: null, requestedAt: 'r', updatedAt: 'u' }
    vi.mocked(getActiveForItem).mockResolvedValue(existing)
    const res = await post({ action: 'requestAwcConversion', id: 5 })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Already converting', conversion: existing })
  })

  // #364: Convert is for upgrading weak audio, so a post with Spotify is fine,
  // and what gets submitted is the article, never the Spotify URL.
  const spotifySource = { id: 1, platform: 'Spotify', link: 'https://open.spotify.com/episode/x', message_id: null, is_primary: true, created_at: 'c', source_label: null }
  const articleRow = { id: 2, platform: 'Substack', link: 'https://ex.com/p', message_id: null, is_primary: false, created_at: 'c', source_label: null }

  it('submits the article URL for a post whose primary source is Spotify', async () => {
    mockFrom.mockReturnValue(makeChain({ data: feedRow({ sources: [spotifySource, articleRow] }), error: null }).chain)
    vi.mocked(requestConversion).mockClear()
    vi.mocked(requestConversion).mockResolvedValue({ ok: true, conversion: { id: 9, status: 'queued', error: null, requestedAt: 'r', updatedAt: 'u' } })
    expect((await post({ action: 'requestAwcConversion', id: 5 })).status).toBe(200)
    expect(requestConversion).toHaveBeenCalledWith(expect.anything(), 5, 'https://ex.com/p')
  })

  it.each([
    ['audio with no article', [spotifySource]],
    ['a private episode', [articleRow, { ...spotifySource, id: 3, platform: 'Askwho Casts', link: 'https://app.askwhocasts.com/x.mp3', is_primary: false }]],
    ['a public show copy', [articleRow, { ...spotifySource, id: 3, is_primary: false, source_label: 'AI Article Readings' }]],
  ])('422s for an item with %s', async (_name, sources) => {
    mockFrom.mockReturnValue(makeChain({ data: feedRow({ sources }), error: null }).chain)
    vi.mocked(requestConversion).mockClear()
    expect((await post({ action: 'requestAwcConversion', id: 5 })).status).toBe(422)
    expect(requestConversion).not.toHaveBeenCalled()
  })

  describe('kind: comments (#368)', () => {
    const lwRow = { id: 2, platform: 'LessWrong', link: 'https://www.lesswrong.com/posts/abc/title', message_id: null, is_primary: true, created_at: 'c', source_label: null }
    it('submits the comments URL, not the article URL', async () => {
      mockFrom.mockReturnValue(makeChain({ data: feedRow({ sources: [lwRow] }), error: null }).chain)
      vi.mocked(requestConversion).mockClear()
      vi.mocked(requestConversion).mockResolvedValue({ ok: true, conversion: { id: 9, kind: 'comments', status: 'queued', error: null, requestedAt: 'r', updatedAt: 'u' } })
      expect((await post({ action: 'requestAwcConversion', id: 5, kind: 'comments' })).status).toBe(200)
      expect(requestConversion).toHaveBeenCalledWith(expect.anything(), 5, 'https://www.lesswrong.com/posts/abc/title#comments', 'comments')
    })
    it('422s for a post with no comments link or an existing comments episode', async () => {
      vi.mocked(requestConversion).mockClear()
      mockFrom.mockReturnValue(makeChain({ data: feedRow(), error: null }).chain)
      expect((await post({ action: 'requestAwcConversion', id: 5, kind: 'comments' })).status).toBe(422)
      mockFrom.mockReturnValue(makeChain({ data: feedRow({ sources: [lwRow, { ...lwRow, id: 3, platform: 'Askwho Casts', link: 'https://app.askwhocasts.com/c.mp3', is_primary: false, source_label: 'Comments' }] }), error: null }).chain)
      expect((await post({ action: 'requestAwcConversion', id: 5, kind: 'comments' })).status).toBe(422)
      expect(requestConversion).not.toHaveBeenCalled()
    })
    it('400s on an unknown kind', async () => {
      vi.mocked(requestConversion).mockClear()
      expect((await post({ action: 'requestAwcConversion', id: 5, kind: 'video' })).status).toBe(400)
      expect(requestConversion).not.toHaveBeenCalled()
    })
  })

  it('404s for a missing item and 400s on the books route', async () => {
    mockFrom.mockReturnValue(makeChain({ data: null, error: null }).chain)
    expect((await post({ action: 'requestAwcConversion', id: 5 })).status).toBe(404)
    expect((await post({ action: 'requestAwcConversion', id: 5 }, BOOKS_CONFIG)).status).toBe(400)
  })
})
