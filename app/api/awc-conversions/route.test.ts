import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/lib/awc/conversions-repo', () => ({ listForPolling: vi.fn(), getHeartbeatAgeSeconds: vi.fn() }))
import { listForPolling, getHeartbeatAgeSeconds } from '@/lib/awc/conversions-repo'
import { GET } from './route'

beforeEach(() => vi.resetAllMocks())

describe('GET /api/awc-conversions', () => {
  it('returns conversions + heartbeat age, uncached', async () => {
    vi.mocked(listForPolling).mockResolvedValue([{ id: 1, contentItemId: 5, status: 'generating', error: null, requestedAt: 'r', updatedAt: 'u' }])
    vi.mocked(getHeartbeatAgeSeconds).mockResolvedValue(12)
    const res = await GET()
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toEqual({ conversions: [{ id: 1, contentItemId: 5, status: 'generating', error: null, requestedAt: 'r', updatedAt: 'u' }], heartbeatAgeSeconds: 12 })
  })
  it('500s when the DB read fails', async () => {
    vi.mocked(listForPolling).mockRejectedValue(new Error('down'))
    vi.mocked(getHeartbeatAgeSeconds).mockResolvedValue(null)
    expect((await GET()).status).toBe(500)
  })
})
