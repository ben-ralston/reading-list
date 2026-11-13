/**
 * Integration test for the curated-picks migration (20261109000000):
 * curation_runs is service-role only and constrained, and a content item
 * clears its own pin / dismissal when it is archived, whoever archives it.
 *
 * Runs only when the local Supabase stack is up (`./run db-start`); skips
 * otherwise (e.g. CI, which has no database).
 */
import { afterAll, describe, expect, it } from 'vitest'
import { detectLocalStack } from './local-stack'

// This project's own local stack only (see local-stack.ts).
const local = detectLocalStack()

describe.skipIf(!local)('curated picks schema', () => {
  const { url, anonKey, serviceRoleKey } = local ?? { url: '', anonKey: '', serviceRoleKey: '' }
  const headers = (key: string) => ({
    apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=representation',
  })
  const service = headers(serviceRoleKey)
  const MARK = `curation-test-${Date.now()}`
  const rest = (path: string, init?: RequestInit) => fetch(`${url}/rest/v1/${path}`, init)

  afterAll(async () => {
    await rest(`curation_runs?input_hash=eq.${MARK}`, { method: 'DELETE', headers: service })
    await rest(`content_items?title=like.${MARK}*`, { method: 'DELETE', headers: service })
  })

  const run = (over: object = {}) => ({
    started_at: new Date().toISOString(), status: 'succeeded', mode: 'agent', model: 'opus',
    items_considered: 2, input_hash: MARK, picks: [{ id: 1, reason: null }], ...over,
  })

  it('locks the anon key out of curation_runs', async () => {
    const res = await rest('curation_runs?select=id&limit=1', { headers: headers(anonKey) })
    expect([401, 403]).toContain(res.status)
  })

  it('lets the service role save and read a run', async () => {
    const res = await rest('curation_runs', { method: 'POST', headers: service, body: JSON.stringify(run()) })
    expect(res.status).toBe(201)
    const [row] = await res.json()
    expect(row.picks).toEqual([{ id: 1, reason: null }])
    expect(row.finished_at).toBeTruthy()
  })

  it('rejects an unknown status and non-array picks', async () => {
    const badStatus = await rest('curation_runs', { method: 'POST', headers: service, body: JSON.stringify(run({ status: 'running' })) })
    expect(badStatus.status).toBe(400)
    const badPicks = await rest('curation_runs', { method: 'POST', headers: service, body: JSON.stringify(run({ picks: { id: 1 } })) })
    expect(badPicks.status).toBe(400)
  })

  const item = (suffix: string, over: object = {}) => ({
    title: `${MARK}-${suffix}`, author: MARK, kind: 'feed', status: '',
    pinned_at: '2026-11-09T00:00:00Z', shortlist_dismissed_at: '2026-11-08T00:00:00Z', ...over,
  })
  const insert = async (body: object) => {
    const res = await rest('content_items', { method: 'POST', headers: service, body: JSON.stringify(body) })
    expect(res.status).toBe(201)
    return (await res.json())[0] as { id: number; pinned_at: string | null; shortlist_dismissed_at: string | null }
  }
  const patch = async (id: number, body: object) => {
    const res = await rest(`content_items?id=eq.${id}`, { method: 'PATCH', headers: service, body: JSON.stringify(body) })
    expect(res.status).toBe(200)
    return (await res.json())[0] as { pinned_at: string | null; shortlist_dismissed_at: string | null }
  }

  it('keeps shortlist state while an item stays active', async () => {
    const row = await insert(item('active'))
    expect(row.pinned_at).not.toBeNull()
    const started = await patch(row.id, { status: 'In Progress' })
    expect(started.pinned_at).not.toBeNull()
    expect(started.shortlist_dismissed_at).not.toBeNull()
  })

  it('clears pin and dismissal when an item is completed or skipped', async () => {
    for (const status of ['Completed', 'Skip']) {
      const row = await insert(item(status))
      const archived = await patch(row.id, { status })
      expect(archived.pinned_at).toBeNull()
      expect(archived.shortlist_dismissed_at).toBeNull()
    }
  })

  it('never stores a pin on a row inserted already archived', async () => {
    const row = await insert(item('born-skipped', { status: 'Skip' }))
    expect(row.pinned_at).toBeNull()
    expect(row.shortlist_dismissed_at).toBeNull()
  })

  // #377: a feed restore is one update that reactivates and pins together;
  // the trigger only clears state when the NEW status is Completed / Skip.
  it('keeps the pin set by a restore that reactivates an archived item', async () => {
    const row = await insert(item('restored', { status: 'Completed' }))
    const now = new Date().toISOString()
    const restored = await patch(row.id, {
      status: '', status_changed_at: now, added_by: 'Restored', pinned_at: now,
      shortlist_dismissed_at: null, queue_position: null, position_confirmed: false,
    }) as { pinned_at: string | null; added_by?: string }
    expect(restored.pinned_at).not.toBeNull()
    expect(restored.added_by).toBe('Restored')
  })
})
