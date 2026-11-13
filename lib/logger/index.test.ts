import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockLog = vi.fn().mockResolvedValue(true)
vi.mock('./logger', () => ({
  log: (...args: unknown[]) => mockLog(...args),
}))

import { logError, logWarn } from './index'

beforeEach(() => {
  mockLog.mockClear()
  mockLog.mockResolvedValue(true)
  vi.stubEnv('VERCEL_ENV', 'production')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('logError gating', () => {
  it('sends nothing when VERCEL_ENV is unset', async () => {
    vi.stubEnv('VERCEL_ENV', '')
    await logError('test', new Error('boom'))
    expect(mockLog).not.toHaveBeenCalled()
  })

  it('sends nothing on preview deployments', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview')
    await logError('test', new Error('boom'))
    expect(mockLog).not.toHaveBeenCalled()
  })

  it('sends in production', async () => {
    await logError('test', new Error('boom'))
    expect(mockLog).toHaveBeenCalledTimes(1)
  })
})

describe('logError payload', () => {
  it('pins app/level/source and formats the message as [context] message', async () => {
    await logError('rss-sync', new Error('feed down'))
    expect(mockLog).toHaveBeenCalledWith(
      'reading-list',
      'error',
      '[rss-sync] Error: feed down',
      expect.objectContaining({ source: 'vercel-production' }),
    )
  })

  it('carries PostgrestError details and extra fields in jsonExtra', async () => {
    const pgErr = { message: 'dup key', code: '23505', hint: 'h', details: 'd' }
    await logError('sync', pgErr, { syncLogId: 7 })
    const opts = mockLog.mock.calls[0][3] as { jsonExtra?: Record<string, unknown> }
    expect(opts.jsonExtra).toEqual({
      error: { code: '23505', hint: 'h', details: 'd' },
      syncLogId: 7,
    })
  })

  it('omits jsonExtra entirely when there are no details and no extra', async () => {
    await logError('sync', new Error('plain'))
    const opts = mockLog.mock.calls[0][3] as Record<string, unknown>
    expect('jsonExtra' in opts).toBe(false)
  })

  it('passes a pre-serialized string message through unchanged (redaction path)', async () => {
    await logError('askwhocasts-sync', 'Too many redirects fetching [redacted]')
    expect(mockLog.mock.calls[0][2]).toBe(
      '[askwhocasts-sync] Too many redirects fetching [redacted]',
    )
  })
})

describe('logError safety', () => {
  it('never rejects even if log throws synchronously', async () => {
    mockLog.mockImplementation(() => {
      throw new Error('shim exploded')
    })
    await expect(logError('test', new Error('x'))).resolves.toBeUndefined()
  })
})

describe('logWarn (#342)', () => {
  // Warn rows are recorded but never raised as alerts by the alerting job
  // (it files error/alert only), so transient upstream failures that already
  // survived retries are visible without becoming spurious issues.
  it('sends at warn level with the same [context] message format and extra', async () => {
    await logWarn('spotify-sync', 'API error: Spotify API error: Bad Gateway', { statusCode: 502 })
    expect(mockLog).toHaveBeenCalledWith(
      'reading-list',
      'warn',
      '[spotify-sync] API error: Spotify API error: Bad Gateway',
      expect.objectContaining({ source: 'vercel-production', jsonExtra: { statusCode: 502 } }),
    )
  })

  it('sends nothing outside production', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview')
    await logWarn('spotify-sync', new Error('boom'))
    expect(mockLog).not.toHaveBeenCalled()
  })

  it('never rejects even if log throws', async () => {
    mockLog.mockImplementation(() => {
      throw new Error('shim exploded')
    })
    await expect(logWarn('test', new Error('x'))).resolves.toBeUndefined()
  })
})
