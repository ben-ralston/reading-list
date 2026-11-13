/**
 * Integration test for #331: place_item_in_queue's p_target_rank resolves a
 * 1-based rank to a live queue_position under the content_items:multirow lock.
 * Positions have gaps (Complete/Skip null a position without closing up the
 * queue), so a rank must never be used as a literal position.
 *
 * Local PostgreSQL only (`./run db-start`); skipped otherwise (CI has no
 * stack). Ranks count the WHOLE kind queue, including the local real data and
 * other suites' fixtures, so every scenario runs in ONE transaction that takes
 * the multi-row lock first (advisory xact locks are re-entrant, so the RPC's
 * own acquire succeeds), measures the queue, places, reads back, and ROLLS
 * BACK — exact positions without racing the other DB suites, and nothing is
 * left behind.
 */
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { localDbUrl } from './local-stack'

// This project's own local stack only (see local-stack.ts); never a fixed port.
const DB = localDbUrl()

let available = false
try {
  available = execFileSync('psql', [DB, '-X', '-qAt', '-c', 'SELECT 1'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000,
  }).trim() === '1'
} catch { /* no local database */ }

/**
 * Run `body` inside BEGIN … ROLLBACK with the multi-row lock held; returns the
 * output lines of its SELECTs. SET CONSTRAINTS ALL IMMEDIATE makes the
 * deferred duplicate-position trigger (#229) check before the rollback.
 */
function inRolledBackTx(body: string): string[] {
  const script = `BEGIN;
    SELECT 'locked' FROM pg_advisory_xact_lock(hashtext('content_items:multirow'));
    ${body}
    SET CONSTRAINTS ALL IMMEDIATE;
    ROLLBACK;`
  return execFileSync('psql', [DB, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', script], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
  }).trim().split('\n').filter((line) => line !== 'locked')
}

const FIXTURES = `
  CREATE TEMP TABLE itest_331 ON COMMIT DROP AS
  WITH base AS (
    SELECT COALESCE(max(queue_position), 0) + 1000 AS b,
           count(queue_position) AS n
    FROM content_items WHERE kind = 'book'
  ), ins AS (
    INSERT INTO content_items(title, author, kind, status, queue_position)
    SELECT 'ITEST-331 ' || v.tag || ' ' || gen_random_uuid(), 'ITEST-331', 'book', '',
           CASE WHEN v.off IS NULL THEN NULL ELSE base.b + v.off END
    FROM base, (VALUES ('a', 10), ('b', 20), ('c', 30), ('new', NULL)) AS v(tag, off)
    RETURNING id, split_part(title, ' ', 2) AS tag, queue_position
  )
  SELECT ins.*, base.b, base.n FROM ins, base;
`

describe.skipIf(!available)('place_item_in_queue p_target_rank (#331)', () => {
  it('resolves a rank to the position the Nth item holds, across gaps', () => {
    // Fixtures a/b/c sit at b+10, b+20, b+30 — far above everything, gapped.
    // Rank n+2 is fixture b (rank n+1 = a), so the new item takes b+20 and
    // b and c shift down by one.
    const [placed, positions] = inRolledBackTx(`${FIXTURES}
      SELECT place_item_in_queue((SELECT id FROM itest_331 WHERE tag = 'new')::int, 'book', NULL, false,
                                 p_target_rank => (SELECT n + 2 FROM itest_331 LIMIT 1)::int)
             - (SELECT b FROM itest_331 LIMIT 1);
      SELECT string_agg(t.tag || '=' || (ci.queue_position - t.b), ',' ORDER BY t.tag)
      FROM itest_331 t JOIN content_items ci ON ci.id = t.id;`)

    expect(placed).toBe('20')
    expect(positions).toBe('a=10,b=21,c=31,new=20')
  })

  it('places one past the last item when the rank exceeds the queue', () => {
    const [placed] = inRolledBackTx(`${FIXTURES}
      SELECT place_item_in_queue((SELECT id FROM itest_331 WHERE tag = 'new')::int, 'book', NULL, false,
                                 p_target_rank => (SELECT n + 99 FROM itest_331 LIMIT 1)::int)
             - (SELECT b FROM itest_331 LIMIT 1);`)

    expect(placed).toBe('31')
  })

  it('keeps the rank as the position in an empty queue (never the pinned position 1)', () => {
    const [placed] = inRolledBackTx(`
      UPDATE content_items SET queue_position = NULL, position_confirmed = false WHERE kind = 'book';
      ${FIXTURES}
      UPDATE content_items SET queue_position = NULL
      WHERE id IN (SELECT id FROM itest_331 WHERE tag <> 'new');
      SELECT place_item_in_queue((SELECT id FROM itest_331 WHERE tag = 'new')::int, 'book', NULL, false,
                                 p_target_rank => 2);`)

    expect(placed).toBe('2')
  })

  it('treats rank <= 0 as rank 1', () => {
    const [placed, first] = inRolledBackTx(`${FIXTURES}
      SELECT place_item_in_queue((SELECT id FROM itest_331 WHERE tag = 'new')::int, 'book', NULL, false,
                                 p_target_rank => 0);
      SELECT min(queue_position) FROM content_items
      WHERE kind = 'book' AND id <> (SELECT id FROM itest_331 WHERE tag = 'new');`)

    expect(Number(placed)).toBeLessThan(Number(first))
  })

  it('keeps literal p_target_position semantics unchanged', () => {
    const [placed] = inRolledBackTx(`${FIXTURES}
      SELECT place_item_in_queue((SELECT id FROM itest_331 WHERE tag = 'new')::int, 'book',
                                 (SELECT b + 25 FROM itest_331 LIMIT 1)::int, false)
             - (SELECT b FROM itest_331 LIMIT 1);`)

    expect(placed).toBe('25')
  })

  it('requires exactly one of p_target_position and p_target_rank', () => {
    expect(() => inRolledBackTx(`${FIXTURES}
      SELECT place_item_in_queue((SELECT id FROM itest_331 WHERE tag = 'new')::int, 'book', NULL, false);`)
    ).toThrow(/exactly one of p_target_position, p_target_rank/)
    expect(() => inRolledBackTx(`${FIXTURES}
      SELECT place_item_in_queue((SELECT id FROM itest_331 WHERE tag = 'new')::int, 'book', 5, false,
                                 p_target_rank => 2);`)
    ).toThrow(/exactly one of p_target_position, p_target_rank/)
  })

})
