/**
 * Integration test for #317: awc_conversions queue semantics against the
 * local Supabase DB. Skips when the local stack is down (CI).
 */
import { execFileSync } from 'node:child_process'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { localDbUrl } from './local-stack'

// This project's own local stack only (see local-stack.ts); never a fixed port.
const DB = localDbUrl()
const PSQL_ARGS = [DB, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c']
function sql(query: string): string {
  return execFileSync('psql', [...PSQL_ARGS, query], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
  }).trim()
}
let available = false
try { available = sql("SELECT to_regclass('public.awc_conversions') IS NOT NULL") === 't' } catch { /* no db */ }

const AUTHOR = 'ITEST-317'
let itemId = 0

describe.skipIf(!available)('awc_conversions (#317)', () => {
  beforeEach(() => {
    sql(`DELETE FROM awc_conversions WHERE content_item_id IN (SELECT id FROM content_items WHERE author='${AUTHOR}')`)
    sql(`DELETE FROM content_items WHERE author='${AUTHOR}'`)
    itemId = Number(sql(`INSERT INTO content_items (title, author, kind, status, word_count)
      VALUES ('AWC itest', '${AUTHOR}', 'feed', '', 1500) RETURNING id`))
  })
  afterAll(() => {
    sql(`DELETE FROM awc_conversions WHERE content_item_id IN (SELECT id FROM content_items WHERE author='${AUTHOR}')`)
    sql(`DELETE FROM content_items WHERE author='${AUTHOR}'`)
  })

  const insertQueued = () =>
    Number(sql(`INSERT INTO awc_conversions (content_item_id, source_url) VALUES (${itemId}, 'https://example.com/a') RETURNING id`))

  it('allows only one active conversion per item', () => {
    insertQueued()
    expect(() => insertQueued()).toThrow(/awc_conversions_one_active_per_item/)
  })

  it('allows a new request once the previous one failed', () => {
    const id = insertQueued()
    sql(`UPDATE awc_conversions SET status='failed' WHERE id=${id}`)
    expect(insertQueued()).toBeGreaterThan(id)
  })

  it('claims the oldest queued row, marks it starting, bumps attempts, returns item fields', () => {
    const id = insertQueued()
    const row = sql(`SELECT id, content_item_id, attempts, title, word_count FROM claim_awc_conversion()`)
    expect(row).toBe(`${id}|${itemId}|1|AWC itest|1500`)
    expect(sql(`SELECT status FROM awc_conversions WHERE id=${id}`)).toBe('starting')
    expect(sql(`SELECT count(*) FROM claim_awc_conversion()`)).toBe('0')
  })

  describe('conversion kinds (#368)', () => {
    const insertComments = () => Number(sql(`INSERT INTO awc_conversions (content_item_id, source_url, kind)
      VALUES (${itemId}, 'https://www.lesswrong.com/posts/abc/t#comments', 'comments') RETURNING id`))

    it('defaults to article and rejects unknown kinds', () => {
      const id = insertQueued()
      expect(sql(`SELECT kind FROM awc_conversions WHERE id=${id}`)).toBe('article')
      sql(`UPDATE awc_conversions SET status='failed' WHERE id=${id}`)
      expect(() => sql(`INSERT INTO awc_conversions (content_item_id, source_url, kind)
        VALUES (${itemId}, 'https://example.com/a', 'video')`)).toThrow(/awc_conversions_valid_kind/)
    })

    // An old daemon calls with no arguments and must never run a comments row
    // as an article: that would spend credits on the wrong episode.
    it('a no-argument claim never returns a comments row', () => {
      const id = insertComments()
      expect(sql(`SELECT count(*) FROM claim_awc_conversion()`)).toBe('0')
      expect(sql(`SELECT status FROM awc_conversions WHERE id=${id}`)).toBe('queued')
    })

    it('a claim naming both kinds returns the row with its kind', () => {
      const id = insertComments()
      expect(sql(`SELECT id, kind FROM claim_awc_conversion(p_kinds => ARRAY['article','comments'])`)).toBe(`${id}|comments`)
    })

    it('allows only one active conversion per item across kinds', () => {
      insertQueued()
      expect(() => insertComments()).toThrow(/awc_conversions_one_active_per_item/)
    })
  })

  const ageRow = (id: number, minutes: number) => {
    sql(`ALTER TABLE awc_conversions DISABLE TRIGGER awc_conversions_updated_at`)
    sql(`UPDATE awc_conversions SET updated_at = now() - interval '${minutes} minutes' WHERE id=${id}`)
    sql(`ALTER TABLE awc_conversions ENABLE TRIGGER awc_conversions_updated_at`)
  }

  it('requeues a row stuck in starting, then fails it after max attempts', () => {
    const id = insertQueued()
    sql(`SELECT * FROM claim_awc_conversion()`)
    ageRow(id, 30)
    // Stale 'starting' → requeued and immediately re-claimed (attempt 2).
    expect(sql(`SELECT attempts FROM claim_awc_conversion()`)).toBe('2')
    ageRow(id, 30)
    expect(sql(`SELECT count(*) FROM claim_awc_conversion()`)).toBe('0')
    expect(sql(`SELECT status || '|' || error FROM awc_conversions WHERE id=${id}`)).toBe('failed|agent stalled')
  })

  it('never requeues a row that stalled mid-run (Generate may already be clicked)', () => {
    const id = insertQueued()
    sql(`SELECT * FROM claim_awc_conversion()`)
    sql(`UPDATE awc_conversions SET status='building_script' WHERE id=${id}`)
    ageRow(id, 30)
    expect(sql(`SELECT count(*) FROM claim_awc_conversion()`)).toBe('0')
    expect(sql(`SELECT status || '|' || attempts FROM awc_conversions WHERE id=${id}`)).toBe('failed|1')
    expect(sql(`SELECT error FROM awc_conversions WHERE id=${id}`)).toMatch(/check Askwho Casts before retrying/)
  })

  it('fails generating rows whose episode never arrived (24h)', () => {
    const id = insertQueued()
    sql(`UPDATE awc_conversions SET status='generating', generating_at = now() - interval '25 hours' WHERE id=${id}`)
    sql(`SELECT * FROM claim_awc_conversion()`)
    expect(sql(`SELECT status || '|' || error FROM awc_conversions WHERE id=${id}`)).toBe('failed|episode never arrived')
  })

  it('is service_role-only (anon/authenticated have no table or RPC access)', () => {
    expect(sql(`SELECT has_table_privilege('anon', 'public.awc_conversions', 'SELECT')`)).toBe('f')
    expect(sql(`SELECT has_table_privilege('authenticated', 'public.awc_conversions', 'INSERT')`)).toBe('f')
    expect(sql(`SELECT has_table_privilege('service_role', 'public.awc_conversions', 'UPDATE')`)).toBe('t')
    expect(sql(`SELECT has_function_privilege('anon', 'public.claim_awc_conversion(int,int,int,text[])', 'EXECUTE')`)).toBe('f')
    expect(sql(`SELECT has_function_privilege('service_role', 'public.claim_awc_conversion(int,int,int,text[])', 'EXECUTE')`)).toBe('t')
  })
})
