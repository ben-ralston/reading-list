import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock Supabase and matching BEFORE importing the route.
const mockFrom = vi.fn()
const mockRpc = vi.fn()
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}))

const mockFindMatchingContent = vi.fn()
vi.mock('@/lib/sync/matching', () => ({
  findMatchingContent: (...args: unknown[]) => mockFindMatchingContent(...args),
}))

import { POST } from './route'

// jsdom can't reliably round-trip a multipart body, so we stub formData()
// directly on the Request — the route only calls request.formData() once.
function makeUpload(csv: string): Request {
  const form = new FormData()
  form.append('file', new File([csv], 'export.csv', { type: 'text/csv' }))
  const req = new Request('http://localhost/api/import/goodreads', { method: 'POST' })
  Object.defineProperty(req, 'formData', {
    value: async () => form,
    configurable: true,
  })
  return req
}

function makeBareRequest(): Request {
  // No formData stub — exercises the "missing file" error path. Override
  // formData to return an empty FormData (which has no 'file' field).
  const req = new Request('http://localhost/api/import/goodreads', { method: 'POST' })
  Object.defineProperty(req, 'formData', {
    value: async () => new FormData(),
    configurable: true,
  })
  return req
}

const SAMPLE_CSV = `Book Id,Title,Author,Year Published,Date Read,Exclusive Shelf
="100","One Existing Book","Author A",2020,,read
="200","Brand New Book","Author B",2021,,to-read
`

interface ChainSpy {
  /** Args passed to .insert() on this chain. */
  inserted: unknown[]
  /** Args passed to .update() on this chain. */
  updated: unknown[]
}

function makeChain(finalResult: { data?: unknown; error?: unknown }): { chain: Record<string, unknown>; spy: ChainSpy } {
  const spy: ChainSpy = { inserted: [], updated: [] }
  const chain: Record<string, unknown> = {}
  Object.assign(chain, {
    select: vi.fn().mockReturnValue(chain),
    insert: vi.fn((arg: unknown) => {
      spy.inserted.push(arg)
      return chain
    }),
    update: vi.fn((arg: unknown) => {
      spy.updated.push(arg)
      return chain
    }),
    eq: vi.fn().mockReturnValue(chain),
    single: vi.fn().mockResolvedValue(finalResult),
  })
  return { chain, spy }
}

beforeEach(() => {
  vi.resetAllMocks()
  // Every .from() call returns a fresh chain that resolves successfully.
  // Tests that need to assert on specific call shapes will use .mockImplementationOnce.
  mockFrom.mockImplementation(() => makeChain({ data: { id: 1 }, error: null }).chain)
})

describe('POST /api/import/goodreads', () => {
  it('rejects requests without a file field', async () => {
    const res = await POST(makeBareRequest())
    expect(res.status).toBe(400)
  })

  it('counts created vs updated vs skipped from parser + matching results', async () => {
    // Row 1: existing match → counted as 'updated'
    // Row 2: no match → counted as 'created'
    mockFindMatchingContent
      .mockResolvedValueOnce({ contentItemId: 555, action: 'update' })
      .mockResolvedValueOnce(null)

    // upsertViaRpc → returns the id of the row
    mockRpc.mockResolvedValue({ data: 777, error: null })

    const res = await POST(makeUpload(SAMPLE_CSV))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.created).toBe(1)
    expect(body.updated).toBe(1)
    expect(body.skipped).toBe(0)
  })

  it('logs parser skips into the result + sync_logs counts', async () => {
    const csv = `Book Id,Title,Author,Year Published,Date Read,Exclusive Shelf
="300","Good Book","Author C",2020,,to-read
="400","Bad Row",,2020,,to-read
`
    mockFindMatchingContent.mockResolvedValue(null)
    mockRpc.mockResolvedValue({ data: 1, error: null })

    const res = await POST(makeUpload(csv))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.created).toBe(1)
    expect(body.skipped).toBe(1)
    expect(body.skipReasons).toHaveLength(1)
    expect(body.skipReasons[0].reason).toMatch(/author/i)
  })

  it('is idempotent on a re-run: every row matches → 0 created, all updated', async () => {
    mockFindMatchingContent.mockResolvedValue({ contentItemId: 1, action: 'update' })
    mockRpc.mockResolvedValue({ data: 1, error: null })

    const res = await POST(makeUpload(SAMPLE_CSV))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.created).toBe(0)
    expect(body.updated).toBe(2)
  })

  it("passes source='goodreads' to the sync log and kind='book' / added_by='goodreads' to the RPC", async () => {
    mockFindMatchingContent.mockResolvedValue(null)
    mockRpc.mockResolvedValue({ data: 1, error: null })

    // Capture the first .from() chain (the sync_logs INSERT) so we can inspect
    // the inserted payload.
    const syncLogsChain = makeChain({ data: { id: 42 }, error: null })
    mockFrom
      .mockImplementationOnce(() => syncLogsChain.chain)
      .mockImplementation(() => makeChain({ data: null, error: null }).chain)

    await POST(makeUpload(SAMPLE_CSV))

    expect(syncLogsChain.spy.inserted[0]).toMatchObject({
      source: 'goodreads',
      status: 'running',
    })

    const firstRpcCall = mockRpc.mock.calls[0]
    expect(firstRpcCall[0]).toBe('insert_or_update_content')
    expect(firstRpcCall[1]).toMatchObject({
      p_kind: 'book',
      p_added_by: 'goodreads',
      p_platform: 'Goodreads',
    })
  })
})
