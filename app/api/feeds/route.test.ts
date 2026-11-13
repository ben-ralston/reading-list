import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockListFeeds = vi.fn()
const mockInsertFeed = vi.fn()
vi.mock('@/lib/rss/feeds-repo', () => ({
  listFeeds: (...a: unknown[]) => mockListFeeds(...a),
  insertFeed: (...a: unknown[]) => mockInsertFeed(...a),
}))
const mockFetchFeed = vi.fn()
vi.mock('@/lib/rss/fetch-feed', () => ({
  fetchFeed: (...a: unknown[]) => mockFetchFeed(...a),
}))

import { GET, POST } from './route'
import { UnsafeUrlError } from '@/lib/safe-fetch'

const post = (b: unknown) =>
  new Request('http://localhost/api/feeds', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(b),
  })

beforeEach(() => {
  mockListFeeds.mockReset(); mockInsertFeed.mockReset(); mockFetchFeed.mockReset()
  mockListFeeds.mockResolvedValue([])
})

describe('GET /api/feeds', () => {
  it('returns the feed list', async () => {
    mockListFeeds.mockResolvedValue([{ id: 1, url: 'u' }])
    const res = await GET(new Request('http://localhost/api/feeds'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ id: 1, url: 'u' }])
    expect(mockListFeeds).toHaveBeenCalledWith({ includeDisabled: false })
  })
  it('passes includeDisabled when ?include=disabled', async () => {
    mockListFeeds.mockResolvedValue([])
    await GET(new Request('http://localhost/api/feeds?include=disabled'))
    expect(mockListFeeds).toHaveBeenCalledWith({ includeDisabled: true })
  })
})

describe('POST /api/feeds', () => {
  it('400s on a missing url', async () => {
    expect((await POST(post({}))).status).toBe(400)
  })
  it('400s on a malformed url', async () => {
    expect((await POST(post({ url: 'not a url' }))).status).toBe(400)
  })
  it('409s on a duplicate url', async () => {
    mockListFeeds.mockResolvedValue([{ url: 'https://x.substack.com/feed' }])
    expect((await POST(post({ url: 'https://x.substack.com/feed' }))).status).toBe(409)
  })
  it('422s when the feed has no items', async () => {
    mockFetchFeed.mockResolvedValue({ title: 'T', items: [] })
    expect((await POST(post({ url: 'https://e.com/rss' }))).status).toBe(422)
  })
  it('422s when fetching throws', async () => {
    mockFetchFeed.mockRejectedValue(new Error('ENOTFOUND'))
    expect((await POST(post({ url: 'https://e.com/rss' }))).status).toBe(422)
  })
  it('422s with a blocked-address error when the SSRF guard rejects the URL', async () => {
    mockFetchFeed.mockRejectedValue(new UnsafeUrlError('Blocked address: 127.0.0.1'))
    const res = await POST(post({ url: 'http://127.0.0.1:8080/feed' }))
    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/blocked or private/i)
  })
  it('creates the feed with detected type + derived label/platform', async () => {
    mockFetchFeed.mockResolvedValue({ title: 'Chan Title', items: [{ title: 'a' }] })
    mockInsertFeed.mockImplementation(async (i) => ({ id: 9, ...i }))
    const res = await POST(post({ url: 'https://foo.substack.com/feed' }))
    expect(res.status).toBe(201)
    expect(mockInsertFeed).toHaveBeenCalledWith({
      url: 'https://foo.substack.com/feed', label: 'Chan Title',
      authorName: 'Chan Title', platform: 'Substack', feedType: 'substack',
      backfillDays: null,
    })
  })

  it('passes a valid backfillDays through to insertFeed', async () => {
    mockFetchFeed.mockResolvedValue({ title: 'T', items: [{ title: 'a' }] })
    mockInsertFeed.mockResolvedValue({ id: 1, url: 'https://x.substack.com/feed' })
    const res = await POST(post({ url: 'https://x.substack.com/feed', backfillDays: 90 }))
    expect(res.status).toBe(201)
    expect(mockInsertFeed).toHaveBeenCalledWith(expect.objectContaining({ backfillDays: 90 }))
  })

  it('omits backfillDays when not provided (off)', async () => {
    mockFetchFeed.mockResolvedValue({ title: 'T', items: [{ title: 'a' }] })
    mockInsertFeed.mockResolvedValue({ id: 1, url: 'https://x.substack.com/feed' })
    await POST(post({ url: 'https://x.substack.com/feed' }))
    const arg = mockInsertFeed.mock.calls[0][0]
    expect(arg.backfillDays == null).toBe(true)
  })

  it('400s on a non-integer backfillDays', async () => {
    mockFetchFeed.mockResolvedValue({ title: 'T', items: [{ title: 'a' }] })
    const res = await POST(post({ url: 'https://x.substack.com/feed', backfillDays: 12.5 }))
    expect(res.status).toBe(400)
    expect(mockInsertFeed).not.toHaveBeenCalled()
  })

  it('400s on a zero / negative backfillDays', async () => {
    mockFetchFeed.mockResolvedValue({ title: 'T', items: [{ title: 'a' }] })
    expect((await POST(post({ url: 'https://x.substack.com/feed', backfillDays: 0 }))).status).toBe(400)
    expect((await POST(post({ url: 'https://x.substack.com/feed', backfillDays: -5 }))).status).toBe(400)
  })

  it('400s on a backfillDays above the 3650 cap', async () => {
    mockFetchFeed.mockResolvedValue({ title: 'T', items: [{ title: 'a' }] })
    expect((await POST(post({ url: 'https://x.substack.com/feed', backfillDays: 3651 }))).status).toBe(400)
  })
  it('409s when insertFeed rejects with a unique-constraint error', async () => {
    mockFetchFeed.mockResolvedValue({ title: 'T', items: [{ title: 'a' }] })
    mockInsertFeed.mockRejectedValue(
      new Error('duplicate key value violates unique constraint')
    )
    expect((await POST(post({ url: 'https://e.com/rss' }))).status).toBe(409)
  })
  it('defaults a generic feed to platform RSS', async () => {
    mockFetchFeed.mockResolvedValue({ title: 'Blog', items: [{ title: 'a' }] })
    mockInsertFeed.mockImplementation(async (i) => ({ id: 1, ...i }))
    await POST(post({ url: 'https://example.com/rss' }))
    expect(mockInsertFeed).toHaveBeenCalledWith(
      expect.objectContaining({ feedType: 'generic', platform: 'RSS' })
    )
  })
})
