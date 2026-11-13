/**
 * Integration test for #205: the publishable anon key must have no access to
 * app data. The app reaches Supabase exclusively with the service_role key
 * (lib/supabase.ts), so anon/authenticated should be locked out of every
 * table, sequence, and RPC in the public schema.
 *
 * Runs only when the local Supabase stack is up (`./run db-start`); skips
 * otherwise (e.g. CI, which has no database).
 */
import { afterAll, describe, expect, it } from 'vitest'
import { detectLocalStack } from './local-stack'

// This project's own local stack only (see local-stack.ts).
const local = detectLocalStack()

describe.skipIf(!local)('RLS scope: anon key is locked out (#205)', () => {
  const { url, anonKey, serviceRoleKey } = local ?? { url: '', anonKey: '', serviceRoleKey: '' }
  const anonHeaders = {
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
    'Content-Type': 'application/json',
  }
  const serviceHeaders = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  }

  // A row id that never exists, so even a vulnerable (pre-fix) run cannot
  // mutate real local data with the DELETE/UPDATE/RPC requests below. The
  // feedback INSERT has no id to miss — on a pre-fix schema it persists a
  // marker row, which the afterAll below deletes with the service key.
  const MISSING_ID = 999_999_999
  const FEEDBACK_MARKER = 'rls-scope-test (#205) — must never persist'

  afterAll(async () => {
    await fetch(`${url}/rest/v1/feedback?feedback_text=eq.${encodeURIComponent(FEEDBACK_MARKER)}`, {
      method: 'DELETE',
      headers: serviceHeaders,
    })
  })

  const expectDenied = (res: Response) => {
    expect([401, 403]).toContain(res.status)
  }

  it('denies anon SELECT on content_items', async () => {
    const res = await fetch(`${url}/rest/v1/content_items?select=id&limit=1`, {
      headers: anonHeaders,
    })
    expectDenied(res)
  })

  it('denies anon DELETE on content_items', async () => {
    const res = await fetch(`${url}/rest/v1/content_items?id=eq.${MISSING_ID}`, {
      method: 'DELETE',
      headers: anonHeaders,
    })
    expectDenied(res)
  })

  it('denies anon UPDATE on content_sources', async () => {
    const res = await fetch(`${url}/rest/v1/content_sources?id=eq.${MISSING_ID}`, {
      method: 'PATCH',
      headers: anonHeaders,
      body: JSON.stringify({ platform: 'rls-scope-test' }),
    })
    expectDenied(res)
  })

  it('denies anon INSERT on feedback', async () => {
    const res = await fetch(`${url}/rest/v1/feedback`, {
      method: 'POST',
      headers: anonHeaders,
      body: JSON.stringify({ feedback_text: FEEDBACK_MARKER }),
    })
    expectDenied(res)
  })

  it('denies anon SELECT on rss_feeds (grant revocation, not just policy)', async () => {
    // rss_feeds has RLS enabled with no policy, so pre-fix anon got an empty
    // 200 via its table grant; post-fix the grant itself is gone.
    const res = await fetch(`${url}/rest/v1/rss_feeds?select=id&limit=1`, {
      headers: anonHeaders,
    })
    expectDenied(res)
  })

  it('denies anon EXECUTE of delete_orphan_content_item', async () => {
    const res = await fetch(`${url}/rest/v1/rpc/delete_orphan_content_item`, {
      method: 'POST',
      headers: anonHeaders,
      body: JSON.stringify({ p_id: MISSING_ID }),
    })
    expectDenied(res)
  })

  it('still allows service_role SELECT on content_items', async () => {
    const res = await fetch(`${url}/rest/v1/content_items?select=id&limit=1`, {
      headers: serviceHeaders,
    })
    expect(res.status).toBe(200)
  })

  it('still allows service_role EXECUTE of delete_orphan_content_item', async () => {
    const res = await fetch(`${url}/rest/v1/rpc/delete_orphan_content_item`, {
      method: 'POST',
      headers: serviceHeaders,
      body: JSON.stringify({ p_id: MISSING_ID }),
    })
    expect(res.status).toBe(200)
  })
})
