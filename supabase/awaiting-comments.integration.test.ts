// Local PostgreSQL only. Every case rolls back its fixtures; never reset the stack.
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { localDbUrl } from './local-stack'

// This project's own local stack only (see local-stack.ts); never a fixed port.
const DB = localDbUrl()
function sql(query: string): string {
  return execFileSync('psql', [DB, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', query], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
  }).trim()
}
let available = false
try { available = sql('SELECT 1') === '1' } catch { /* no local database */ }

const id = '(SELECT id FROM fixture)'
const sync = (status = 'Completed', progress = '96') => `
  SELECT apply_spotify_progress(jsonb_build_array(jsonb_build_object(
    'id', ${id}, 'status', '${status}', 'progress', '${progress}')));`
function scenario(body: string, platform = 'LessWrong', status = 'In Progress') {
  const output = sql(`BEGIN;
    CREATE TEMP TABLE fixture ON COMMIT DROP AS WITH inserted AS (
      INSERT INTO content_items(title, author, kind, status, progress, status_changed_at)
      VALUES ('ITEST-266 ' || gen_random_uuid(), 'ITEST-266', 'feed', '${status}', '50', '2026-01-01')
      RETURNING id
    ) SELECT id FROM inserted;
    INSERT INTO content_sources(content_item_id, platform, link, is_primary)
      SELECT id, '${platform}', 'https://www.lesswrong.com/posts/test/title', false FROM fixture;
    ${body}
    SELECT row_to_json(c) FROM content_items c WHERE id = ${id};
    ROLLBACK;`)
  return JSON.parse(output.split('\n').filter(Boolean).at(-1)!)
}

describe.skipIf(!available)('Awaiting comments persistence (#266)', () => {
  it('retains a confirmed queue position and actual progress after completion', () => {
    const row = scenario(`UPDATE content_items SET queue_position = 926600, position_confirmed = true WHERE id = ${id}; ${sync()}`)
    expect(row).toMatchObject({ status: 'Awaiting comments', progress: '96', queue_position: 926600, position_confirmed: true })
  })
  it('preserves the pending status and timestamp across repeated completion and replay', () => {
    const row = scenario(`${sync()} UPDATE content_items SET status_changed_at = '2026-02-01' WHERE id = ${id}; ${sync()} ${sync('In Progress', '20')}`)
    expect(row.status).toBe('Awaiting comments')
    expect(row.progress).toBe('96')
    expect(row.status_changed_at).toContain('2026-02-01')
  })
  it.each(['Completed', 'Skip'])('does not resurrect archived LessWrong %s', (status) => {
    const row = scenario(sync(), 'LessWrong', status)
    expect(row.status).toBe(status)
    expect(row.status_changed_at).toContain('2026-01-01')
  })
  it('preserves a manual completion before a delayed sync', () => {
    const row = scenario(`${sync()} UPDATE content_items SET status = 'Completed', queue_position = null, position_confirmed = false WHERE id = ${id}; ${sync()}`)
    expect(row.status).toBe('Completed')
  })
  it('continues to archive ordinary Spotify items and clear their position', () => {
    const row = scenario(`UPDATE content_items SET queue_position = 926600, position_confirmed = true WHERE id = ${id}; ${sync()}`, 'Spotify')
    expect(row).toMatchObject({ status: 'Completed', queue_position: null, position_confirmed: false })
  })
  it('retains ordinary Skip to Completed behavior', () => {
    expect(scenario(sync(), 'Spotify', 'Skip').status).toBe('Completed')
  })
  it('does not downgrade an ordinary completed item', () => {
    expect(scenario(sync('In Progress', '20'), 'Spotify', 'Completed').status).toBe('Completed')
  })
  it('uses completion status even when fully-played arrives with low progress', () => {
    expect(scenario(sync('Completed', '10'))).toMatchObject({ status: 'Awaiting comments', progress: '50' })
  })
  it('preserves the existing progress high-water rule including unparseable values', () => {
    expect(scenario(`UPDATE content_items SET progress = '80% complete' WHERE id = ${id}; ${sync('In Progress', '20')}`).progress).toBe('80% complete')
    expect(scenario(`UPDATE content_items SET progress = 'Chapter three' WHERE id = ${id}; ${sync('In Progress', '20')}`).progress).toBe('20')
  })
  it('gates only feed items, not books', () => {
    expect(scenario(`UPDATE content_items SET kind = 'book' WHERE id = ${id}; ${sync()}`).status).toBe('Completed')
  })
  it('leaves non-completed LessWrong listening in progress', () => {
    expect(scenario(sync('In Progress', '75')).status).toBe('In Progress')
  })
  it('protects pending comments through the legacy SQL sync entry point', () => {
    const row = scenario(`${sync()} SELECT sync_progress('substack', jsonb_build_array(jsonb_build_object(
      'title', (SELECT title FROM content_items WHERE id = ${id}), 'author', 'ITEST-266', 'status', 'Completed', 'progress', '100')));`)
    expect(row).toMatchObject({ status: 'Awaiting comments', progress: '100' })
  })
  it('routes legacy Spotify completion through the same policy', () => {
    const row = scenario(`SELECT sync_progress('spotify', jsonb_build_array(jsonb_build_object(
      'title', (SELECT title FROM content_items WHERE id = ${id}), 'author', 'ITEST-266', 'status', 'Completed', 'progress', '100')));`)
    expect(row.status).toBe('Awaiting comments')
  })
  it('keeps comments pending while non-Spotify progress advances', () => {
    const row = scenario(`${sync()} SELECT apply_content_progress(${id}, '100', 'Completed');`)
    expect(row).toMatchObject({ status: 'Awaiting comments', progress: '100' })
  })
  it('retains the non-Spotify archived guard', () => {
    const row = scenario(`SELECT apply_content_progress(${id}, '100', 'In Progress', true);`, 'Audible', 'Completed')
    expect(row).toMatchObject({ status: 'Completed', progress: '50' })
  })
  it('does not resurrect an item when manual completion overlaps a Spotify write', async () => {
    const itemId = Number(sql(`INSERT INTO content_items(title, author, status, kind)
      VALUES ('ITEST-266 race ' || gen_random_uuid(), 'ITEST-266', 'Awaiting comments', 'feed') RETURNING id`))
    try {
      sql(`INSERT INTO content_sources(content_item_id, platform, link)
        VALUES (${itemId}, 'LessWrong', 'https://www.lesswrong.com/posts/test/title')`)
      const run = promisify(execFile)
      const completion = run('psql', [DB, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c',
        `BEGIN; UPDATE content_items SET status = 'Completed' WHERE id = ${itemId}; SELECT pg_sleep(0.8); COMMIT;`])
      // Wait until the completion transaction holds the row lock, not merely
      // until its process starts. The following RPC must wait for COMMIT.
      const deadline = Date.now() + 5000
      while (sql(`SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid()
        AND query LIKE '%WHERE id = ${itemId}; SELECT pg_sleep%' AND wait_event = 'PgSleep'`) === '0') {
        if (Date.now() > deadline) throw new Error('completion did not acquire lock')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      await run('psql', [DB, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c',
        `SELECT apply_spotify_progress('[{"id":${itemId},"status":"Completed","progress":"100"}]')`])
      await completion
      expect(sql(`SELECT status FROM content_items WHERE id = ${itemId}`)).toBe('Completed')
    } finally {
      sql(`DELETE FROM content_sources WHERE content_item_id = ${itemId}; DELETE FROM content_items WHERE id = ${itemId}`)
    }
  })
  it('does not expose the new RPC to public clients', () => {
    expect(sql("SELECT has_function_privilege('anon', 'public.apply_spotify_progress(jsonb)', 'EXECUTE') OR has_function_privilege('authenticated', 'public.apply_spotify_progress(jsonb)', 'EXECUTE')")).toBe('f')
  })
})
