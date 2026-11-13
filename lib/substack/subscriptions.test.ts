import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchSubstackSubscriptions } from './subscriptions'

function mockFetchOnce(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const res = {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  }
  const fetchMock = vi.fn().mockResolvedValue(res)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchSubstackSubscriptions', () => {
  it('derives canonical <subdomain>.substack.com feed URLs, ignoring custom_domain', async () => {
    const fetchMock = mockFetchOnce({
      subscriptions: [
        { publication: { name: 'Astral Codex Ten', subdomain: 'astralcodexten', custom_domain: 'www.astralcodexten.com' } },
        { publication: { name: "Don't Worry About the Vase", subdomain: 'thezvi', custom_domain: null } },
      ],
      subscriptionsTruncated: false,
    })

    const { subs, truncated } = await fetchSubstackSubscriptions('examplereader')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://substack.com/api/v1/user/examplereader/public_profile',
      expect.objectContaining({ headers: expect.objectContaining({ 'User-Agent': expect.any(String) }) }),
    )
    expect(subs).toEqual([
      { name: 'Astral Codex Ten', subdomain: 'astralcodexten', feedUrl: 'https://astralcodexten.substack.com/feed' },
      { name: "Don't Worry About the Vase", subdomain: 'thezvi', feedUrl: 'https://thezvi.substack.com/feed' },
    ])
    expect(truncated).toBe(false)
  })

  it('passes through the subscriptionsTruncated flag', async () => {
    mockFetchOnce({
      subscriptions: [{ publication: { name: 'A', subdomain: 'a' } }],
      subscriptionsTruncated: true,
    })

    const { truncated } = await fetchSubstackSubscriptions('x')

    expect(truncated).toBe(true)
  })

  it('lowercases the subdomain when building the feed URL', async () => {
    mockFetchOnce({
      subscriptions: [{ publication: { name: 'Zvi', subdomain: 'TheZvi' } }],
      subscriptionsTruncated: false,
    })

    const { subs } = await fetchSubstackSubscriptions('x')

    expect(subs).toEqual([
      { name: 'Zvi', subdomain: 'thezvi', feedUrl: 'https://thezvi.substack.com/feed' },
    ])
  })

  it('skips subscriptions whose subdomain has invalid characters', async () => {
    mockFetchOnce({
      subscriptions: [
        { publication: { name: 'Evil', subdomain: 'evil.com/' } },
        { publication: { name: 'Dotted', subdomain: 'foo.bar' } },
        { publication: { name: 'OK', subdomain: 'ok' } },
      ],
      subscriptionsTruncated: false,
    })

    const { subs } = await fetchSubstackSubscriptions('x')

    expect(subs).toEqual([
      { name: 'OK', subdomain: 'ok', feedUrl: 'https://ok.substack.com/feed' },
    ])
  })

  it('skips subscriptions with a blank or missing subdomain', async () => {
    mockFetchOnce({
      subscriptions: [
        { publication: { name: 'No Subdomain', subdomain: '', custom_domain: 'x.com' } },
        { publication: { name: 'Missing', custom_domain: 'y.com' } },
        { publication: { name: 'OK', subdomain: 'ok' } },
      ],
      subscriptionsTruncated: false,
    })

    const { subs } = await fetchSubstackSubscriptions('x')

    expect(subs).toEqual([
      { name: 'OK', subdomain: 'ok', feedUrl: 'https://ok.substack.com/feed' },
    ])
  })

  it('throws on a non-200 response', async () => {
    mockFetchOnce({}, { ok: false, status: 401 })

    await expect(fetchSubstackSubscriptions('x')).rejects.toThrow(/401/)
  })
})
