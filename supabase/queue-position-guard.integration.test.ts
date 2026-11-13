/**
 * Integration test for #229: duplicate (kind, queue_position) must be
 * impossible to commit. Guarded by a DEFERRABLE INITIALLY DEFERRED
 * constraint trigger so legit multi-row shifts (place_item_in_queue,
 * Make Next renumbers) that are transiently duplicated mid-transaction
 * still commit.
 *
 * Runs only when the local Supabase stack is up (`./run db-start`) AND the
 * 20260717000000 migration has been applied; skips otherwise (e.g. CI).
 *
 * Only touches rows it creates (positions >= 99990, far above the real
 * queue), so the shared local stack's real data is never renumbered.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { detectLocalStack } from './local-stack'

// This project's own local stack only (see local-stack.ts).
const local = detectLocalStack()

describe.skipIf(!local)('queue_position uniqueness guard (#229)', () => {
  const { url, serviceRoleKey } = local ?? { url: '', serviceRoleKey: '' }
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  }
  const TITLE_PREFIX = 'ITEST-229 guard'
  const TEST_AUTHOR = 'ITEST-229'

  // Direct INSERT into content_items is normally forbidden (dedup goes through
  // upsert_content_item) — acceptable here: throwaway local-only rows with
  // unique titles, deleted in afterAll, and the test needs precise control of
  // queue_position.
  async function insertItem(title: string, queuePosition: number | null): Promise<number> {
    const res = await fetch(`${url}/rest/v1/content_items`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify({
        title,
        author: TEST_AUTHOR,
        kind: 'feed',
        status: '',
        queue_position: queuePosition,
        position_confirmed: false,
      }),
    })
    expect(res.status).toBe(201)
    const [row] = await res.json()
    return row.id
  }

  async function setPosition(id: number, queuePosition: number): Promise<Response> {
    return fetch(`${url}/rest/v1/content_items?id=eq.${id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ queue_position: queuePosition }),
    })
  }

  let itemA = 0
  let itemB = 0

  beforeAll(async () => {
    itemA = await insertItem(`${TITLE_PREFIX} A`, 99999)
    itemB = await insertItem(`${TITLE_PREFIX} B`, null)
  })

  afterAll(async () => {
    // Test items have no content_sources rows, so a direct delete is safe.
    await fetch(`${url}/rest/v1/content_items?author=eq.${encodeURIComponent(TEST_AUTHOR)}`, {
      method: 'DELETE',
      headers,
    })
  })

  it('rejects a write that duplicates an occupied position', async () => {
    const res = await setPosition(itemB, 99999) // itemA already holds 99999
    expect(res.ok).toBe(false)
    const body = await res.json()
    expect(JSON.stringify(body)).toContain('duplicate queue_position')

    // itemB must be unchanged (still unpositioned)
    const check = await fetch(
      `${url}/rest/v1/content_items?id=eq.${itemB}&select=queue_position`,
      { headers },
    )
    const [row] = await check.json()
    expect(row.queue_position).toBeNull()
  })

  it('allows a write to a free position', async () => {
    const res = await setPosition(itemB, 99998)
    expect(res.ok).toBe(true)
  })

  it('place_item_in_queue multi-row shift still commits (deferred check)', async () => {
    // Place a third item at 99998: shifts itemB (99998) and itemA (99999) down
    // by one inside a single transaction — transient duplicates mid-shift must
    // not trip the guard because it checks at COMMIT.
    const itemC = await insertItem(`${TITLE_PREFIX} C`, null)
    const res = await fetch(`${url}/rest/v1/rpc/place_item_in_queue`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        p_item_id: itemC,
        p_kind: 'feed',
        p_target_position: 99998,
        p_position_confirmed: false,
      }),
    })
    expect(res.ok).toBe(true)

    const check = await fetch(
      `${url}/rest/v1/content_items?author=eq.${encodeURIComponent(TEST_AUTHOR)}&select=id,queue_position&order=queue_position.asc`,
      { headers },
    )
    const rows: { id: number; queue_position: number }[] = await check.json()
    const positions = rows.map(r => r.queue_position)
    expect(new Set(positions).size).toBe(positions.length) // all unique
    expect(rows.find(r => r.id === itemC)?.queue_position).toBe(99998)
  })
})
