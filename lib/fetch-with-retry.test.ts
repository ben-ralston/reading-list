import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchWithRetry } from './fetch-with-retry'

// Speed up tests by eliminating retry delays
vi.useFakeTimers({ shouldAdvanceTime: true })

describe('fetchWithRetry', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('succeeds on first try', async () => {
    const mockResponse = new Response('ok', { status: 200 })
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse)

    const result = await fetchWithRetry('/api/test')
    expect(result).toBe(mockResponse)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('retries on TypeError (network failure)', async () => {
    const mockResponse = new Response('ok', { status: 200 })
    vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('Load failed'))
      .mockResolvedValueOnce(mockResponse)

    const result = await fetchWithRetry('/api/test', undefined, { retries: 2, baseDelay: 1 })
    expect(result).toBe(mockResponse)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('retries on 500 server error', async () => {
    const errorResponse = new Response('error', { status: 500 })
    const okResponse = new Response('ok', { status: 200 })
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorResponse)
      .mockResolvedValueOnce(okResponse)

    const result = await fetchWithRetry('/api/test', undefined, { retries: 2, baseDelay: 1 })
    expect(result).toBe(okResponse)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('cancels the body of a 5xx response before retrying (frees the socket, #342)', async () => {
    const errorResponse = new Response('error', { status: 503 })
    const cancel = vi.spyOn(errorResponse.body!, 'cancel')
    const okResponse = new Response('ok', { status: 200 })
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorResponse)
      .mockResolvedValueOnce(okResponse)

    const result = await fetchWithRetry('/api/test', undefined, { retries: 2, baseDelay: 1 })
    expect(result).toBe(okResponse)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('does not retry on 400 client error', async () => {
    const errorResponse = new Response('bad request', { status: 400 })
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(errorResponse)

    const result = await fetchWithRetry('/api/test', undefined, { retries: 2, baseDelay: 1 })
    expect(result).toBe(errorResponse)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('exhausts retries and throws original TypeError', async () => {
    const networkError = new TypeError('Load failed')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(networkError)

    await expect(
      fetchWithRetry('/api/test', undefined, { retries: 2, baseDelay: 1 }),
    ).rejects.toThrow(networkError)
    expect(fetch).toHaveBeenCalledTimes(3) // 1 initial + 2 retries
  })

  it('respects custom retry options', async () => {
    const mockResponse = new Response('ok', { status: 200 })
    vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('Load failed'))
      .mockRejectedValueOnce(new TypeError('Load failed'))
      .mockRejectedValueOnce(new TypeError('Load failed'))
      .mockResolvedValueOnce(mockResponse)

    const result = await fetchWithRetry('/api/test', undefined, { retries: 3, baseDelay: 1 })
    expect(result).toBe(mockResponse)
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('does not retry non-TypeError exceptions', async () => {
    const error = new Error('AbortError')
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(error)

    await expect(
      fetchWithRetry('/api/test', undefined, { retries: 2, baseDelay: 1 }),
    ).rejects.toThrow(error)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
