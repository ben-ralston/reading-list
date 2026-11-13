import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFrom = vi.fn()
vi.mock('@/lib/supabase', () => ({
  supabase: { from: (...a: unknown[]) => mockFrom(...a) },
}))

import { listRecentRuns, listRecentErrors } from './sync-logs-repo'

const ROW = {
  id: 1, source: 'spotify', status: 'success',
  started_at: '2026-05-24T09:00:00Z', completed_at: '2026-05-24T09:01:00Z',
  items_processed: 5, items_created: 3, items_updated: 1, items_skipped: 1,
  error_message: null, metadata: null,
}

beforeEach(() => mockFrom.mockReset())

describe('listRecentRuns', () => {
  it('queries by source, newest first, mapped to camelCase', async () => {
    const limit = vi.fn().mockResolvedValue({ data: [ROW], error: null })
    const order = vi.fn().mockReturnValue({ limit })
    const eq = vi.fn().mockReturnValue({ order })
    const select = vi.fn().mockReturnValue({ eq })
    mockFrom.mockReturnValue({ select })

    const runs = await listRecentRuns('spotify', 5)

    expect(mockFrom).toHaveBeenCalledWith('sync_logs')
    expect(eq).toHaveBeenCalledWith('source', 'spotify')
    expect(order).toHaveBeenCalledWith('started_at', { ascending: false })
    expect(limit).toHaveBeenCalledWith(5)
    expect(runs[0]).toMatchObject({
      id: 1, source: 'spotify', itemsCreated: 3, itemsSkipped: 1, errorMessage: null,
    })
  })

  it('coerces null item counts to 0', async () => {
    const limit = vi.fn().mockResolvedValue({
      data: [{ ...ROW, items_processed: null, items_created: null, items_updated: null, items_skipped: null }],
      error: null,
    })
    const order = vi.fn().mockReturnValue({ limit })
    const eq = vi.fn().mockReturnValue({ order })
    mockFrom.mockReturnValue({ select: vi.fn().mockReturnValue({ eq }) })

    const runs = await listRecentRuns('spotify')
    expect(runs[0]).toMatchObject({ itemsProcessed: 0, itemsCreated: 0, itemsUpdated: 0, itemsSkipped: 0 })
  })

  it('preserves a partial status (a valid sync_logs status)', async () => {
    const limit = vi.fn().mockResolvedValue({ data: [{ ...ROW, status: 'partial' }], error: null })
    const order = vi.fn().mockReturnValue({ limit })
    const eq = vi.fn().mockReturnValue({ order })
    mockFrom.mockReturnValue({ select: vi.fn().mockReturnValue({ eq }) })

    const runs = await listRecentRuns('rss')
    expect(runs[0].status).toBe('partial')
  })

  it('returns [] and logs on a Supabase error (does not throw)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const limit = vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } })
    const order = vi.fn().mockReturnValue({ limit })
    const eq = vi.fn().mockReturnValue({ order })
    mockFrom.mockReturnValue({ select: vi.fn().mockReturnValue({ eq }) })

    const runs = await listRecentRuns('spotify')
    expect(runs).toEqual([])
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('listRecentErrors', () => {
  it('filters status=error, newest first, mapped', async () => {
    const limit = vi.fn().mockResolvedValue({ data: [{ ...ROW, status: 'error', error_message: 'boom' }], error: null })
    const order = vi.fn().mockReturnValue({ limit })
    const eq = vi.fn().mockReturnValue({ order })
    const select = vi.fn().mockReturnValue({ eq })
    mockFrom.mockReturnValue({ select })

    const runs = await listRecentErrors(20)

    expect(eq).toHaveBeenCalledWith('status', 'error')
    expect(order).toHaveBeenCalledWith('started_at', { ascending: false })
    expect(limit).toHaveBeenCalledWith(20)
    expect(runs[0]).toMatchObject({ status: 'error', errorMessage: 'boom' })
  })

  it('returns [] on error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const limit = vi.fn().mockResolvedValue({ data: null, error: { message: 'x' } })
    const order = vi.fn().mockReturnValue({ limit })
    const eq = vi.fn().mockReturnValue({ order })
    mockFrom.mockReturnValue({ select: vi.fn().mockReturnValue({ eq }) })
    expect(await listRecentErrors()).toEqual([])
    spy.mockRestore()
  })
})
