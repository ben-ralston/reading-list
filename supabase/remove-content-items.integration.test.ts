/**
 * Integration test for #305: remove_content_items deletes items (sources
 * first — content_sources has a non-cascading FK) and closes the queue gaps
 * the removed items leave, atomically and behind the shared multi-row writer
 * lock (its lock wait is covered in multirow-writer-lock.integration.test.ts).
 *
 * Local PostgreSQL only (`./run db-start`); skipped otherwise (CI has no
 * stack). Fixtures are BOOK rows at positions >= 305001: the other DB suites
 * shift the feed queue concurrently (place_item_in_queue at 99998 / 337101),
 * while nothing else touches books that high, so exact positions are stable.
 * The real book queue sits far below and is never shifted.
 */
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { localDbUrl } from './local-stack'

// This project's own local stack only (see local-stack.ts); never a fixed port.
const DB = localDbUrl()
function sql(query: string): string {
  return execFileSync('psql', [DB, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', query], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
  }).trim()
}

let available = false
try {
  available = sql('SELECT 1') === '1'
} catch { /* no local database */ }

const AUTHOR = 'ITEST-305'
const BASE = 305000

function cleanup() {
  sql(`DELETE FROM content_sources WHERE content_item_id IN (SELECT id FROM content_items WHERE author = '${AUTHOR}');
       DELETE FROM content_items WHERE author = '${AUTHOR}'`)
}

/** Insert book fixtures at BASE + offset (null = unplaced); returns ids in order. */
function insertBooks(offsets: (number | null)[]): number[] {
  const values = offsets
    .map((o) => `('ITEST-305 ' || gen_random_uuid(), '${AUTHOR}', 'book', '', ${o === null ? 'NULL' : BASE + o})`)
    .join(',\n')
  return sql(`INSERT INTO content_items(title, author, kind, status, queue_position)
    VALUES ${values} RETURNING id`).split('\n').map(Number)
}

function positions(ids: number[]): Record<number, number | null> {
  const out: Record<number, number | null> = {}
  for (const row of sql(`SELECT id || ':' || COALESCE(queue_position::text, 'null')
      FROM content_items WHERE id IN (${ids.join(',')})`).split('\n').filter(Boolean)) {
    const [id, pos] = row.split(':')
    out[Number(id)] = pos === 'null' ? null : Number(pos)
  }
  return out
}

describe.skipIf(!available)('remove_content_items (#305)', () => {
  beforeAll(cleanup) // self-heal after a killed run
  afterAll(cleanup)

  it('deletes the items with their sources and feedback, and closes the gaps they leave', () => {
    const [a, b, c, d, e, f, unplaced] = insertBooks([1, 2, 3, 4, 5, 6, null])
    sql(`INSERT INTO content_sources(content_item_id, platform, link, is_primary)
         VALUES (${b}, 'Spotify', 'https://open.spotify.com/episode/itest305b', true),
                (${unplaced}, 'Spotify', 'https://open.spotify.com/episode/itest305u', true);
         INSERT INTO feedback(content_item_id, feedback_text) VALUES (${d}, 'ITEST-305')`)

    const removed = sql(`SELECT remove_content_items(ARRAY[${b}, ${d}, ${unplaced}]::bigint[])`)

    expect(Number(removed)).toBe(3)
    expect(sql(`SELECT count(*) FROM content_items WHERE id IN (${b}, ${d}, ${unplaced})`)).toBe('0')
    expect(sql(`SELECT count(*) FROM content_sources WHERE content_item_id IN (${b}, ${unplaced})`)).toBe('0')
    expect(sql(`SELECT count(*) FROM feedback WHERE content_item_id = ${d}`)).toBe('0')
    // Survivors keep their order and close up: no gap where b and d were.
    expect(positions([a, c, e, f])).toEqual({
      [a]: BASE + 1,
      [c]: BASE + 2,
      [e]: BASE + 3,
      [f]: BASE + 4,
    })
  })

  it('never shifts rows below the removed position', () => {
    const bookBelow = sql(`SELECT count(*) FROM content_items WHERE kind = 'book' AND queue_position < ${BASE}`)
    const bookBelowSum = sql(`SELECT COALESCE(sum(queue_position), 0) FROM content_items WHERE kind = 'book' AND queue_position < ${BASE}`)
    const [g, h] = insertBooks([50, 51])

    sql(`SELECT remove_content_items(ARRAY[${g}]::bigint[])`)

    expect(positions([h])).toEqual({ [h]: BASE + 50 })
    expect(sql(`SELECT count(*) FROM content_items WHERE kind = 'book' AND queue_position < ${BASE}`)).toBe(bookBelow)
    expect(sql(`SELECT COALESCE(sum(queue_position), 0) FROM content_items WHERE kind = 'book' AND queue_position < ${BASE}`)).toBe(bookBelowSum)
  })

  it('skips rows changed since the caller read them (expected updated_at)', () => {
    const [m, n, o] = insertBooks([60, 61, 62])
    const snapshot = (id: number) => sql(`SELECT updated_at FROM content_items WHERE id = ${id}`)
    const [mTs, nTs] = [snapshot(m), snapshot(n)]
    // n is touched after the caller's read (e.g. Spotify recorded progress).
    sql(`UPDATE content_items SET progress = '15' WHERE id = ${n}`)

    const removed = sql(`SELECT remove_content_items(ARRAY[${m}, ${n}]::bigint[],
      ARRAY['${mTs}', '${nTs}']::timestamptz[])`)

    expect(Number(removed)).toBe(1)
    expect(positions([n, o])).toEqual({ [n]: BASE + 60, [o]: BASE + 61 })
  })

  it('rejects mismatched id / expected-timestamp arrays', () => {
    const [p] = insertBooks([70])
    expect(() => sql(`SELECT remove_content_items(ARRAY[${p}]::bigint[], ARRAY[]::timestamptz[])`)).toThrow()
    expect(positions([p])).toEqual({ [p]: BASE + 70 })
  })

  it('is a no-op for an empty or unknown id list', () => {
    const [k] = insertBooks([80])
    expect(sql(`SELECT remove_content_items(ARRAY[]::bigint[])`)).toBe('0')
    expect(sql(`SELECT remove_content_items(ARRAY[-1]::bigint[])`)).toBe('0')
    expect(positions([k])).toEqual({ [k]: BASE + 80 })
  })

  it('is not executable by public clients', () => {
    expect(sql(`SELECT has_function_privilege('anon', 'public.remove_content_items(bigint[],timestamptz[])', 'EXECUTE')
      OR has_function_privilege('authenticated', 'public.remove_content_items(bigint[],timestamptz[])', 'EXECUTE')`)).toBe('f')
    expect(sql(`SELECT has_function_privilege('service_role', 'public.remove_content_items(bigint[],timestamptz[])', 'EXECUTE')`)).toBe('t')
  })
})
