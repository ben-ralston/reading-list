import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockUpdateFeed = vi.fn()
vi.mock('@/lib/rss/feeds-repo', () => ({
  updateFeed: (...a: unknown[]) => mockUpdateFeed(...a),
}))

import { PATCH } from './route'

const req = (b: unknown) =>
  new Request('http://localhost/api/feeds/1', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(b),
  })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => mockUpdateFeed.mockReset())

describe('PATCH /api/feeds/[id]', () => {
  it('400s on a non-numeric id', async () => {
    expect((await PATCH(req({ active: false }), ctx('abc'))).status).toBe(400)
  })
  it('400s when no valid fields are supplied', async () => {
    expect((await PATCH(req({ bogus: 1 }), ctx('1'))).status).toBe(400)
  })
  it('404s when the feed does not exist', async () => {
    mockUpdateFeed.mockResolvedValue(null)
    expect((await PATCH(req({ active: false }), ctx('1'))).status).toBe(404)
  })
  it('disables a feed and returns the updated row', async () => {
    mockUpdateFeed.mockResolvedValue({ id: 1, active: false })
    const res = await PATCH(req({ active: false }), ctx('1'))
    expect(res.status).toBe(200)
    expect(mockUpdateFeed).toHaveBeenCalledWith(1, { active: false })
  })
  it('edits the label and returns the updated row', async () => {
    mockUpdateFeed.mockResolvedValue({ id: 3, label: 'New Name' })
    const res = await PATCH(req({ label: 'New Name' }), ctx('3'))
    expect(res.status).toBe(200)
    expect(mockUpdateFeed).toHaveBeenCalledWith(3, { label: 'New Name' })
  })
})
