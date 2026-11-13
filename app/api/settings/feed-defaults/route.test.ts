import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGet = vi.fn()
const mockSet = vi.fn()
vi.mock('@/lib/app-settings', () => ({
  getDefaultBackfillDays: (...a: unknown[]) => mockGet(...a),
  setDefaultBackfillDays: (...a: unknown[]) => mockSet(...a),
  ALLOWED_BACKFILL_PRESETS: [30, 90, 365],
}))

import { GET, PUT } from './route'

const put = (b: unknown) =>
  new Request('http://localhost/api/settings/feed-defaults', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(b),
  })

beforeEach(() => {
  mockGet.mockReset(); mockSet.mockReset()
  mockSet.mockResolvedValue(undefined)
})

describe('GET /api/settings/feed-defaults', () => {
  it('returns the current default', async () => {
    mockGet.mockResolvedValue(90)
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ defaultBackfillDays: 90 })
  })

  it('returns null when off', async () => {
    mockGet.mockResolvedValue(null)
    expect(await (await GET()).json()).toEqual({ defaultBackfillDays: null })
  })
})

describe('PUT /api/settings/feed-defaults', () => {
  it('sets a valid preset', async () => {
    const res = await PUT(put({ defaultBackfillDays: 90 }))
    expect(res.status).toBe(200)
    expect(mockSet).toHaveBeenCalledWith(90)
  })

  it('clears the default with null', async () => {
    const res = await PUT(put({ defaultBackfillDays: null }))
    expect(res.status).toBe(200)
    expect(mockSet).toHaveBeenCalledWith(null)
  })

  it('400s on a non-preset value', async () => {
    const res = await PUT(put({ defaultBackfillDays: 42 }))
    expect(res.status).toBe(400)
    expect(mockSet).not.toHaveBeenCalled()
  })

  it('400s on a missing field', async () => {
    const res = await PUT(put({}))
    expect(res.status).toBe(400)
    expect(mockSet).not.toHaveBeenCalled()
  })

  it('500s when the accessor throws', async () => {
    mockSet.mockRejectedValue(new Error('db down'))
    const res = await PUT(put({ defaultBackfillDays: 90 }))
    expect(res.status).toBe(500)
  })
})
