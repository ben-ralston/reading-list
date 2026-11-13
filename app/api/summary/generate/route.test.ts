import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock generateSummary
vi.mock('@/lib/summary', () => ({
  generateSummary: vi.fn(),
}))

describe('POST /api/summary/generate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 400 when contentItemId is missing', async () => {
    const { POST } = await import('./route')
    const request = new Request('http://localhost/api/summary/generate', {
      method: 'POST',
      body: JSON.stringify({}),
    })

    const response = await POST(request)
    expect(response.status).toBe(400)
  })

  it('returns generated summary and structured data on success', async () => {
    const { generateSummary } = await import('@/lib/summary')
    const summaryData = { oneLiner: 'A great book.', bullets: ['a', 'b', 'c', 'd'], sourceAccess: 'full_text' as const, model: 'claude-opus-5-5' }
    vi.mocked(generateSummary).mockResolvedValue({
      summary: 'A great book.',
      summaryData,
      generatedAt: '2026-03-14T00:00:00Z',
    })

    const { POST } = await import('./route')
    const request = new Request('http://localhost/api/summary/generate', {
      method: 'POST',
      body: JSON.stringify({ contentItemId: 1 }),
    })

    const response = await POST(request)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.summary).toBe('A great book.')
    expect(body.summaryData).toEqual(summaryData)
    // Manual generation never opts into the ingest back-catalog guard.
    expect(generateSummary).toHaveBeenCalledWith(1, { skipExisting: undefined })
  })

  it('returns 500 when generation fails', async () => {
    const { generateSummary } = await import('@/lib/summary')
    vi.mocked(generateSummary).mockRejectedValue(new Error('API error'))

    const { POST } = await import('./route')
    const request = new Request('http://localhost/api/summary/generate', {
      method: 'POST',
      body: JSON.stringify({ contentItemId: 1 }),
    })

    const response = await POST(request)
    expect(response.status).toBe(500)
  })
})
