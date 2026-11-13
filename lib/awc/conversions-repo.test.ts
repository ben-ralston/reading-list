import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  requestConversion, getActiveForItem, setStage, recordResult, findGeneratingScriptConversion,
  markDoneForItem, getHeartbeatAgeSeconds, claimNext,
} from './conversions-repo'

function makeChain(result: { data?: unknown; error?: unknown }) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'neq', 'in', 'or', 'gt', 'gte', 'order', 'limit']) {
    chain[m] = vi.fn((...args: unknown[]) => { calls.push({ method: m, args }); return chain })
  }
  chain.single = vi.fn().mockResolvedValue(result)
  chain.maybeSingle = vi.fn().mockResolvedValue(result)
  ;(chain as { then: unknown }).then = (f: (v: unknown) => unknown) => Promise.resolve(result).then(f)
  return { chain, calls }
}
function dbWith(chain: unknown, rpcResult?: unknown) {
  return { from: vi.fn(() => chain), rpc: vi.fn().mockResolvedValue(rpcResult) } as unknown as SupabaseClient
}

describe('requestConversion', () => {
  it('inserts a queued row and returns its summary', async () => {
    const { chain, calls } = makeChain({ data: { id: 7, status: 'queued', error: null, requested_at: 'r', updated_at: 'u' }, error: null })
    const res = await requestConversion(dbWith(chain), 42, 'https://example.com/a')
    expect(calls.find((c) => c.method === 'insert')?.args[0]).toEqual({ content_item_id: 42, source_url: 'https://example.com/a', kind: 'article' })
    expect(res).toEqual({ ok: true, conversion: { kind: 'article', id: 7, status: 'queued', error: null, requestedAt: 'r', updatedAt: 'u' } })
  })
  it('maps a unique violation to already_active', async () => {
    const { chain } = makeChain({ data: null, error: { code: '23505', message: 'dup' } })
    expect(await requestConversion(dbWith(chain), 42, 'https://example.com/a')).toEqual({ ok: false, reason: 'already_active' })
  })
  it('throws other errors', async () => {
    const { chain } = makeChain({ data: null, error: { code: '500', message: 'boom' } })
    await expect(requestConversion(dbWith(chain), 42, 'https://x.y')).rejects.toMatchObject({ message: 'boom' })
  })
})

describe('setStage / recordResult guards', () => {
  it('setStage only moves in-flight rows and stamps generating_at for generating', async () => {
    const { chain, calls } = makeChain({ error: null })
    await setStage(dbWith(chain), 5, 'generating')
    const update = calls.find((c) => c.method === 'update')!.args[0] as Record<string, unknown>
    expect(update.status).toBe('generating')
    expect(typeof update.generating_at).toBe('string')
    expect(calls).toContainEqual({ method: 'in', args: ['status', ['starting', 'submitting_url', 'building_script', 'generating']] })
  })
  it('recordResult never overwrites a row the sync already marked done', async () => {
    const { chain, calls } = makeChain({ error: null })
    await recordResult(dbWith(chain), 5, { outcome: 'generating', path: 'script', episodeTitle: 'T', credits: 12 })
    expect(calls).toContainEqual({ method: 'in', args: ['status', ['starting', 'submitting_url', 'building_script', 'generating']] })
    const update = calls.find((c) => c.method === 'update')!.args[0] as Record<string, unknown>
    expect(update).toMatchObject({ status: 'generating', path: 'script', episode_title: 'T', credits: 12 })
  })
  it('recordResult stores a short-episode warning in error, leaving the row generating (#363)', async () => {
    const { chain, calls } = makeChain({ error: null })
    await recordResult(dbWith(chain), 5, { outcome: 'generating', path: 'script', episodeTitle: 'T', credits: 5, warning: 'short episode: 5 credits for about 3,542 words' })
    const update = calls.find((c) => c.method === 'update')!.args[0] as Record<string, unknown>
    expect(update).toMatchObject({ status: 'generating', credits: 5, error: 'short episode: 5 credits for about 3,542 words' })
  })
  it('recordResult leaves error untouched without a warning', async () => {
    const { chain, calls } = makeChain({ error: null })
    await recordResult(dbWith(chain), 5, { outcome: 'generating', path: 'url', episodeTitle: 'T', credits: 30 })
    expect(calls.find((c) => c.method === 'update')!.args[0]).not.toHaveProperty('error')
  })
  it('recordResult failed sets error + completed_at, but never fails a generating row', async () => {
    const { chain, calls } = makeChain({ error: null })
    await recordResult(dbWith(chain), 5, { outcome: 'failed', path: null, error: 'timeout' })
    const update = calls.find((c) => c.method === 'update')!.args[0] as Record<string, unknown>
    expect(update).toMatchObject({ status: 'failed', error: 'timeout' })
    expect(typeof update.completed_at).toBe('string')
    // Generate was already clicked once a row is 'generating': a late failure
    // must not invite a paid Retry.
    expect(calls).toContainEqual({ method: 'in', args: ['status', ['starting', 'submitting_url', 'building_script']] })
  })
})

describe('conversion kinds (#368)', () => {
  it('requests a comments conversion with its kind', async () => {
    const { chain } = makeChain({ data: { id: 7, status: 'queued', error: null, requested_at: 'r', updated_at: 'u', kind: 'comments' }, error: null })
    const result = await requestConversion(dbWith(chain), 10, 'https://www.lesswrong.com/posts/a/b#comments', 'comments')
    expect(vi.mocked(chain.insert as never)).toHaveBeenCalledWith({ content_item_id: 10, source_url: 'https://www.lesswrong.com/posts/a/b#comments', kind: 'comments' })
    expect(result).toMatchObject({ ok: true, conversion: { kind: 'comments' } })
  })
  it('closes only rows of the given kind', async () => {
    const { chain, calls } = makeChain({ data: null, error: null })
    await markDoneForItem(dbWith(chain), 10, 'comments')
    expect(calls).toContainEqual({ method: 'eq', args: ['kind', 'comments'] })
  })
  it('defaults markDone to the article kind', async () => {
    const { chain, calls } = makeChain({ data: null, error: null })
    await markDoneForItem(dbWith(chain), 10)
    expect(calls).toContainEqual({ method: 'eq', args: ['kind', 'article'] })
  })
  it('asks for both kinds and returns the claim kind', async () => {
    const row = { id: 1, content_item_id: 2, source_url: 'u', attempts: 1, title: 't', author: 'a', word_count: null, kind: 'comments' }
    const db = dbWith({}, { data: [row], error: null })
    expect(await claimNext(db)).toMatchObject({ kind: 'comments' })
    expect(db.rpc).toHaveBeenCalledWith('claim_awc_conversion', { p_kinds: ['article', 'comments'] })
  })
  it('returns the kind of the request an episode matches', async () => {
    const { chain } = makeChain({ data: [{ id: 3, content_item_id: 4, episode_title: 'Comments: T', kind: 'comments' }], error: null })
    expect(await findGeneratingScriptConversion(dbWith(chain), 'Comments: T')).toEqual({ id: 3, contentItemId: 4, kind: 'comments' })
  })
})

describe('findGeneratingScriptConversion', () => {
  it('matches exactly one generating script row by normalized title', async () => {
    const { chain } = makeChain({ data: [
      { id: 1, content_item_id: 10, episode_title: 'Your Wisconsin Primary, Researched' },
      { id: 2, content_item_id: 11, episode_title: 'Something else' },
    ], error: null })
    expect(await findGeneratingScriptConversion(dbWith(chain), 'your wisconsin primary, researched'))
      .toEqual({ id: 1, contentItemId: 10, kind: 'article' })
  })
  it('returns null when two rows share the normalized title', async () => {
    const { chain } = makeChain({ data: [
      { id: 1, content_item_id: 10, episode_title: 'Same' },
      { id: 2, content_item_id: 11, episode_title: 'same' },
    ], error: null })
    expect(await findGeneratingScriptConversion(dbWith(chain), 'Same')).toBeNull()
  })
  it('returns null when nothing matches', async () => {
    const { chain } = makeChain({ data: [], error: null })
    expect(await findGeneratingScriptConversion(dbWith(chain), 'Unrelated Studio episode')).toBeNull()
  })
})

describe('markDoneForItem', () => {
  it('closes every not-yet-done row of that item (incl. failed: the episode arrived anyway)', async () => {
    const { chain, calls } = makeChain({ error: null })
    await markDoneForItem(dbWith(chain), 10)
    expect(calls).toContainEqual({ method: 'eq', args: ['content_item_id', 10] })
    expect(calls).toContainEqual({ method: 'neq', args: ['status', 'done'] })
  })
  it('leaves error alone, so a short-episode warning survives the row closing (#363)', async () => {
    const { chain, calls } = makeChain({ error: null })
    await markDoneForItem(dbWith(chain), 10)
    expect(calls.find((c) => c.method === 'update')!.args[0]).not.toHaveProperty('error')
  })
})

describe('heartbeat + claim', () => {
  it('computes heartbeat age in seconds, null when absent', async () => {
    const { chain } = makeChain({ data: { value: '2026-10-04T12:00:00.000Z' }, error: null })
    expect(await getHeartbeatAgeSeconds(dbWith(chain), Date.parse('2026-10-04T12:01:30Z'))).toBe(90)
    const { chain: empty } = makeChain({ data: null, error: null })
    expect(await getHeartbeatAgeSeconds(dbWith(empty), Date.now())).toBeNull()
  })
  it('claimNext maps the RPC row, null when the queue is empty', async () => {
    const db = dbWith({}, { data: [{ id: 3, content_item_id: 9, source_url: 'https://a.b', attempts: 1, title: 'T', author: 'A', word_count: 900, kind: 'article' }], error: null })
    expect(await claimNext(db)).toEqual({ id: 3, kind: 'article', contentItemId: 9, sourceUrl: 'https://a.b', attempts: 1, title: 'T', author: 'A', wordCount: 900 })
    expect(await claimNext(dbWith({}, { data: [], error: null }))).toBeNull()
  })
})

describe('getActiveForItem (#317 review)', () => {
  it('returns the active row of the item, null when none', async () => {
    const { chain, calls } = makeChain({ data: { id: 7, status: 'starting', error: null, requested_at: 'r', updated_at: 'u' }, error: null })
    expect(await getActiveForItem(dbWith(chain), 5)).toEqual({ kind: 'article', id: 7, status: 'starting', error: null, requestedAt: 'r', updatedAt: 'u' })
    expect(calls).toContainEqual({ method: 'eq', args: ['content_item_id', 5] })
    expect(calls).toContainEqual({ method: 'in', args: ['status', ['queued', 'starting', 'submitting_url', 'building_script', 'generating']] })
    const { chain: none } = makeChain({ data: null, error: null })
    expect(await getActiveForItem(dbWith(none), 5)).toBeNull()
  })
})
