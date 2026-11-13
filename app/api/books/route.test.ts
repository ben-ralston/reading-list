import { describe, it, expect, vi, beforeEach } from 'vitest'

// #189: completing/skipping a book must revalidate BOTH /books and
// /books/archive so neither surface serves a stale snapshot.
const mockFrom = vi.fn()
vi.mock('@/lib/supabase', () => ({
  supabase: { from: (...a: unknown[]) => mockFrom(...a), rpc: vi.fn() },
}))

const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({
  revalidatePath: (...a: unknown[]) => revalidatePath(...a),
}))

import { POST } from './route'

function makeChain(finalResult: { data?: unknown; error?: unknown }) {
  const chain: Record<string, unknown> = {}
  const ret = () => chain
  Object.assign(chain, {
    select: vi.fn(ret),
    update: vi.fn(ret),
    eq: vi.fn(ret),
    single: vi.fn().mockResolvedValue(finalResult),
  })
  return chain
}

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.USE_MOCK_DATA
})

describe('/api/books revalidation (#189)', () => {
  it('revalidates BOTH /books and /books/archive when a book is completed', async () => {
    mockFrom.mockReturnValue(
      makeChain({
        data: { id: 1001, title: 'X', author: 'Y', sources: [], kind: 'book' },
        error: null,
      }),
    )

    const req = new Request('http://localhost/api/books', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'updateStatus', id: 1001, status: 'Completed' }),
    })

    const res = await POST(req)
    expect(res.status).toBe(200)

    expect(revalidatePath).toHaveBeenCalledWith('/books')
    expect(revalidatePath).toHaveBeenCalledWith('/books/archive')
  })
})
