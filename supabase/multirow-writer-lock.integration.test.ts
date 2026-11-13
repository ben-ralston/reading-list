/**
 * Integration test for #337 (ops issue #337): every
 * multi-row content_items writer must serialize behind the shared advisory
 * lock `content_items:multirow`, taken as its FIRST statement. Two multi-row
 * writers that lock rows in different orders (apply_spotify_progress by id,
 * place_item_in_queue's shift by queue_position) deadlocked in prod on
 * 2026-09-14; with the shared lock they run one at a time.
 *
 * Local PostgreSQL only (`./run db-start`); skipped otherwise (CI has no
 * stack). Only touches rows it creates: titles/authors tagged ITEST-337 and
 * feed positions >= 337000, far above every other suite's fixtures
 * (queue-position-guard owns 99998/99999) and the real queue.
 *
 * Mechanics: a background psql "holder" (driven over stdin) takes the advisory
 * lock and idles in its transaction; the RPC under test is started and must be
 * observed waiting on `wait_event = 'advisory'`; the holder then COMMITs and
 * the RPC completes. The lock is held only for as long as it takes to observe
 * the wait (tens of ms), so the other DB suites — whose real RPCs now queue
 * behind this lock — are not slowed. The barrier and the wait check key on
 * unique tokens embedded in each statement's text.
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { localDbUrl } from './local-stack'

// This project's own local stack only (see local-stack.ts); never a fixed port.
const DB = localDbUrl()
const PSQL_ARGS = [DB, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c']
function sql(query: string): string {
  return execFileSync('psql', [...PSQL_ARGS, query], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
  }).trim()
}
const run = promisify(execFile)
const runSql = (query: string) => run('psql', [...PSQL_ARGS, query])

let available = false
try { available = sql('SELECT 1') === '1' } catch { /* no local database */ }

const LOCK_KEY = "hashtext('content_items:multirow')"
const AUTHOR = 'ITEST-337'
const OBSERVE_DEADLINE_MS = 8_000
const TEST_TIMEOUT = 30_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, deadlineMs: number, what: string): Promise<void> {
  const deadline = Date.now() + deadlineMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}

function backendCount(token: string, extra: string): number {
  return Number(sql(`SELECT count(*) FROM pg_stat_activity
    WHERE pid <> pg_backend_pid() AND query LIKE '%${token}%' AND ${extra}`))
}

/**
 * Runs `rpcSql` while a holder transaction owns the advisory lock. Resolves
 * with whether the RPC was seen blocked on the advisory lock, whether it had
 * already finished before the holder released the lock, and its stdout.
 */
async function raceAgainstHolder(rpcSql: string) {
  const token = `ITEST-337-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const holderToken = `${token}-holder`
  const rpcToken = `${token}-rpc`

  const holder = spawn('psql', [DB, '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'ignore', 'pipe'] })
  let holderStderr = ''
  holder.stderr.on('data', (chunk) => { holderStderr += chunk })
  const holderExit = new Promise<void>((resolve, reject) => {
    holder.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`holder exited ${code}: ${holderStderr}`))))
  })
  holder.stdin.write(`BEGIN;\nSELECT pg_advisory_xact_lock(${LOCK_KEY}) /* ${holderToken} */;\n`)
  try {
    // Wait until the holder actually owns the lock (idle inside its open
    // transaction), not merely until its process started.
    await waitFor(() => backendCount(holderToken, "state = 'idle in transaction'") > 0, 5_000, 'holder to own the lock')

    let rpcDone = false
    const rpc = runSql(`${rpcSql} /* ${rpcToken} */`).then(({ stdout }) => {
      rpcDone = true
      return stdout.trim()
    })
    let seenWaiting = false
    const deadline = Date.now() + OBSERVE_DEADLINE_MS
    while (!seenWaiting && !rpcDone && Date.now() < deadline) {
      seenWaiting = backendCount(rpcToken, "wait_event_type = 'Lock' AND wait_event = 'advisory'") > 0
      if (!seenWaiting) await sleep(25)
    }
    const finishedBeforeRelease = rpcDone
    holder.stdin.end('COMMIT;\n')
    await holderExit
    const rpcOut = await rpc
    return { seenWaiting, finishedBeforeRelease, rpcOut }
  } catch (err) {
    holder.stdin.end('ROLLBACK;\n')
    await holderExit.catch(() => undefined)
    throw err
  }
}

describe.skipIf(!available)('multi-row content_items writers share one advisory lock (#337)', () => {
  const ids: number[] = []
  const syncLogIds: number[] = []
  let itemA = 0
  let itemB = 0
  let unplaced = 0
  let removable = 0
  let titleA = ''

  beforeAll(() => {
    // Self-heal: a run killed before afterAll leaves rows at 337101/337102,
    // and the deferred unique-position trigger would then reject every later
    // fixture insert on this local DB.
    sql(`DELETE FROM content_sources WHERE content_item_id IN (SELECT id FROM content_items WHERE author = '${AUTHOR}');
         DELETE FROM content_items WHERE author = '${AUTHOR}'`)
    // One statement for all fixtures: the #229 suite's shift (target 99998,
    // parallel worker) moves every feed row above it, so two separate INSERTs
    // at adjacent positions could be split by it and trip the deferred
    // duplicate-position trigger.
    const rows = sql(`INSERT INTO content_items(title, author, kind, status, progress, queue_position)
      VALUES ('ITEST-337 A ' || gen_random_uuid(), '${AUTHOR}', 'feed', '', '10', 337101),
             ('ITEST-337 B ' || gen_random_uuid(), '${AUTHOR}', 'feed', '', '10', 337102),
             ('ITEST-337 N ' || gen_random_uuid(), '${AUTHOR}', 'feed', '', '10', NULL),
             ('ITEST-337 R ' || gen_random_uuid(), '${AUTHOR}', 'feed', '', '10', NULL)
      RETURNING id`).split('\n').map(Number)
    ;[itemA, itemB, unplaced, removable] = rows
    ids.push(...rows)
    titleA = sql(`SELECT title FROM content_items WHERE id = ${itemA}`)
  })

  afterAll(() => {
    if (ids.length === 0) return
    if (syncLogIds.length > 0) sql(`DELETE FROM sync_logs WHERE id IN (${syncLogIds.join(',')})`)
    sql(`DELETE FROM content_sources WHERE content_item_id IN (${ids.join(',')});
         DELETE FROM content_items WHERE id IN (${ids.join(',')})`)
  })

  it('apply_spotify_progress waits for the lock holder', async () => {
    const { seenWaiting, finishedBeforeRelease } = await raceAgainstHolder(
      `SELECT apply_spotify_progress('[{"id":${itemA},"status":"In Progress","progress":"20"},{"id":${itemB},"status":"In Progress","progress":"20"}]')`
    )
    expect(seenWaiting).toBe(true)
    expect(finishedBeforeRelease).toBe(false)
  }, TEST_TIMEOUT)

  it('batch_update_content_items waits for the lock holder', async () => {
    const { seenWaiting, finishedBeforeRelease } = await raceAgainstHolder(
      `SELECT batch_update_content_items('[{"id":${itemA},"progress":"30"},{"id":${itemB},"progress":"30"}]')`
    )
    expect(seenWaiting).toBe(true)
    expect(finishedBeforeRelease).toBe(false)
  }, TEST_TIMEOUT)

  it('sync_progress (non-spotify branch) waits for the lock holder', async () => {
    const payload = JSON.stringify([{ title: titleA, author: AUTHOR, progress: '40', status: 'In Progress' }])
    const { seenWaiting, finishedBeforeRelease, rpcOut } = await raceAgainstHolder(
      `SELECT sync_progress('substack', '${payload.replace(/'/g, "''")}')`
    )
    // The legacy entry point writes its own sync_logs row; remove it in afterAll.
    syncLogIds.push(Number(JSON.parse(rpcOut).sync_log_id))
    expect(seenWaiting).toBe(true)
    expect(finishedBeforeRelease).toBe(false)
  }, TEST_TIMEOUT)

  it('place_item_in_queue waits for the lock holder and still shifts correctly', async () => {
    // Target A's live position. The #229 suite's shift can still move A and B
    // between this read and the placement (the RPC waits on the holder), so
    // the assertions below check order and A/B adjacency, not exact offsets.
    const target = Number(sql(`SELECT queue_position FROM content_items WHERE id = ${itemA}`))
    const { seenWaiting, finishedBeforeRelease } = await raceAgainstHolder(
      `SELECT place_item_in_queue(${unplaced}, 'feed', ${target}, false)`
    )
    expect(seenWaiting).toBe(true)
    expect(finishedBeforeRelease).toBe(false)
    // Regression: replacing the per-kind key changes nothing observable — the
    // new item lands at/after the target and ahead of both fixtures, which
    // shifted down together and stay adjacent.
    const rows = sql(`SELECT id || ':' || queue_position FROM content_items
      WHERE id IN (${ids.join(',')}) ORDER BY queue_position`).split('\n')
    const [first, second, third] = rows.map((row) => row.split(':').map(Number))
    expect(first[0]).toBe(unplaced)
    expect(first[1]).toBeGreaterThanOrEqual(target)
    expect(second[0]).toBe(itemA)
    expect(second[1]).toBeGreaterThan(first[1])
    expect(third).toEqual([itemB, second[1] + 1])
  }, TEST_TIMEOUT)

  it('remove_content_items waits for the lock holder (#305)', async () => {
    // Unplaced fixture: removing it closes no gap, so no feed row shifts
    // under the concurrently running suites.
    const { seenWaiting, finishedBeforeRelease, rpcOut } = await raceAgainstHolder(
      `SELECT remove_content_items(ARRAY[${removable}]::bigint[])`
    )
    expect(seenWaiting).toBe(true)
    expect(finishedBeforeRelease).toBe(false)
    expect(rpcOut).toBe('1')
  }, TEST_TIMEOUT)

  it.each([
    'public.apply_spotify_progress(jsonb)',
    'public.place_item_in_queue(integer,text,integer,boolean,boolean,integer)',
    'public.batch_update_content_items(jsonb)',
    'public.sync_progress(text,jsonb)',
    'public.remove_content_items(bigint[],timestamptz[])',
  ])('%s is not executable by public clients', (signature) => {
    expect(sql(`SELECT has_function_privilege('anon', '${signature}', 'EXECUTE')
      OR has_function_privilege('authenticated', '${signature}', 'EXECUTE')`)).toBe('f')
  })
})
