import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSetSeen = vi.fn()
vi.mock('@/lib/app-settings', () => ({ setEverythingLastSeen: (...a: unknown[]) => mockSetSeen(...a) }))

import { POST } from './route'

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/settings/everything-seen', { method: 'POST', body: JSON.stringify(body) }))

beforeEach(() => { mockSetSeen.mockReset() })

describe('POST /api/settings/everything-seen (#377)', () => {
  it('records the visit time', async () => {
    mockSetSeen.mockResolvedValue(undefined)
    const res = await post({ seenAt: '2026-11-09T12:00:00.000Z' })
    expect(res.status).toBe(200)
    expect(mockSetSeen).toHaveBeenCalledWith('2026-11-09T12:00:00.000Z', expect.any(Number))
  })

  it('rejects a missing or unparseable time', async () => {
    expect((await post({})).status).toBe(400)
    expect((await post({ seenAt: 'nope' })).status).toBe(400)
    expect(mockSetSeen).not.toHaveBeenCalled()
  })

  it('returns 500 when the write fails', async () => {
    mockSetSeen.mockRejectedValue(new Error('db down'))
    const res = await post({ seenAt: '2026-11-09T12:00:00.000Z' })
    expect(res.status).toBe(500)
  })

})
