import { describe, it, expect, vi, beforeEach } from 'vitest'

// #189: when a mutation moves a feed item between the queue and the archive,
// BOTH surfaces must be revalidated — not just the queue it left.
const mockFrom = vi.fn()
const mockRpc = vi.fn()
vi.mock('@/lib/supabase', () => ({
  supabase: { from: (...a: unknown[]) => mockFrom(...a), rpc: (...a: unknown[]) => mockRpc(...a) },
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
    gte: vi.fn(ret),
    neq: vi.fn(ret),
    in: vi.fn(ret),
    order: vi.fn(ret),
    single: vi.fn().mockResolvedValue(finalResult),
    maybeSingle: vi.fn().mockResolvedValue(finalResult),
  })
  // Make the chain awaitable for list-style selects (no .single()).
  ;(chain as unknown as PromiseLike<unknown>).then = (onfulfilled?: (v: unknown) => unknown) =>
    Promise.resolve(finalResult).then(onfulfilled)
  return chain
}

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.USE_MOCK_DATA
})

describe('/api/queue revalidation (#189)', () => {
  it('revalidates BOTH / and /archive when a feed item is completed', async () => {
    mockFrom.mockReturnValue(
      makeChain({
        data: { id: 7, title: 'X', author: 'Y', sources: [], kind: 'feed' },
        error: null,
      }),
    )

    const req = new Request('http://localhost/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'updateStatus', id: 7, status: 'Completed' }),
    })

    const res = await POST(req)
    expect(res.status).toBe(200)

    expect(revalidatePath).toHaveBeenCalledWith('/')
    expect(revalidatePath).toHaveBeenCalledWith('/archive')
  })

  it('revalidates /, /archive and /everything when restoring an item (archive -> queue)', async () => {
    // restoreItem moves an item the OTHER direction (archive -> queue). On the
    // feed it is one guarded single-row update that also pins the item (#377).
    mockFrom.mockReturnValue(
      makeChain({ data: { id: 7, title: 'X', author: 'Y', sources: [], kind: 'feed' }, error: null }),
    )

    const req = new Request('http://localhost/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'restoreItem', id: 7 }),
    })

    const res = await POST(req)
    expect(res.status).toBe(200)

    expect(mockRpc).not.toHaveBeenCalled()
    expect(revalidatePath).toHaveBeenCalledWith('/')
    expect(revalidatePath).toHaveBeenCalledWith('/archive')
    expect(revalidatePath).toHaveBeenCalledWith('/everything')
  })

  it('makeNext on the feed pins the item instead of placing a queue position (#377)', async () => {
    mockFrom.mockReturnValue(
      makeChain({ data: { id: 7, title: 'X', author: 'Y', sources: [], kind: 'feed' }, error: null }),
    )

    const req = new Request('http://localhost/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'makeNext', id: 7 }),
    })

    const res = await POST(req)
    expect(res.status).toBe(200)

    expect(mockRpc).not.toHaveBeenCalled()
    expect(revalidatePath).toHaveBeenCalledWith('/')
    expect(revalidatePath).toHaveBeenCalledWith('/everything')
  })
})
