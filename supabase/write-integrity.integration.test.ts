// @vitest-environment node
/**
 * Integration test for #207 (RLV-023): concurrent upsert_content_item calls
 * with the same (title, author, kind) must dedup onto a single content_items
 * row. Pre-#207 the RPC's SELECT-then-INSERT raced, so a double-tap "Save to
 * Reading List" or overlapping sync crons created duplicate items; the
 * 20260711000000 migration adds a unique expression index + ON CONFLICT.
 *
 * Runs only when the local Supabase stack is up (`./run db-start`); skips
 * otherwise (e.g. CI, which has no database). Writes only synthetic rows to
 * the LOCAL database and cleans them up.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { detectLocalStack } from './local-stack'

// This project's own local stack only (see local-stack.ts).
const local = detectLocalStack()

describe.skipIf(!local)('upsert_content_item dedup race (#207)', () => {
  const { url, serviceRoleKey } = local ?? { url: '', serviceRoleKey: '' }
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  }

  // Unique per run so a leftover row from an aborted run can't cause a
  // false failure; cleanup deletes by this title.
  const TITLE = `Write-integrity race probe ${process.pid}-${Date.now()}`
  const AUTHOR = 'Integration Test (#207)'

  const upsert = (payload: Record<string, unknown>) =>
    fetch(`${url}/rest/v1/rpc/upsert_content_item`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        p_title: TITLE,
        p_author: AUTHOR,
        p_platform: 'RSS',
        p_link: 'https://example.com/write-integrity-race',
        p_kind: 'feed',
        p_added_by: 'integration-test',
        ...payload,
      }),
    })

  const fetchItems = async () => {
    const res = await fetch(
      `${url}/rest/v1/content_items?title=eq.${encodeURIComponent(TITLE)}&select=id`,
      { headers }
    )
    expect(res.status).toBe(200)
    return (await res.json()) as Array<{ id: number }>
  }

  afterAll(async () => {
    const items = await fetchItems()
    if (items.length === 0) return
    const ids = items.map((i) => i.id).join(',')
    await fetch(`${url}/rest/v1/content_sources?content_item_id=in.(${ids})`, {
      method: 'DELETE',
      headers,
    })
    await fetch(`${url}/rest/v1/content_items?id=in.(${ids})`, {
      method: 'DELETE',
      headers,
    })
  })

  it('concurrent identical upserts create exactly one content_items row', async () => {
    const N = 8
    const responses = await Promise.all(Array.from({ length: N }, () => upsert({})))
    for (const res of responses) {
      expect(res.status).toBe(200)
    }
    // RETURNS TABLE(content_id, inserted) → one-row array per call.
    const rows = (await Promise.all(responses.map((r) => r.json()))).map(
      (body) => (body as Array<{ content_id: number; inserted: boolean }>)[0]
    )

    const distinctIds = new Set(rows.map((r) => r.content_id))
    expect(distinctIds.size).toBe(1)
    expect(rows.filter((r) => r.inserted)).toHaveLength(1)

    const items = await fetchItems()
    expect(items).toHaveLength(1)

    // The losers must not have attached duplicate sources either: the whole
    // RPC is one transaction, so they only run after the winner committed
    // item + source and their source-exists check sees it.
    const src = await fetch(
      `${url}/rest/v1/content_sources?content_item_id=eq.${[...distinctIds][0]}&select=id`,
      { headers }
    )
    expect(((await src.json()) as unknown[]).length).toBe(1)
  })

  it('a later identical upsert dedups onto the same row', async () => {
    const items = await fetchItems()
    expect(items).toHaveLength(1)

    const res = await upsert({})
    expect(res.status).toBe(200)
    const [row] = (await res.json()) as Array<{ content_id: number; inserted: boolean }>

    expect(row.content_id).toBe(items[0].id)
    expect(row.inserted).toBe(false)
    expect(await fetchItems()).toHaveLength(1)
  })
})
