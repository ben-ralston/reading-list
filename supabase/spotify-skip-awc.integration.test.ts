// Local PostgreSQL only. Every case rolls back its fixtures; never reset the stack.
// #364: an old played Spotify episode must not complete an item the owner is now
// hearing through Askwho Casts.
import { execFileSync } from 'node:child_process'
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
const update = (source: string | null, status = 'Completed', progress = '100') => `
  SELECT apply_spotify_progress(jsonb_build_array(jsonb_build_object(
    'id', ${id}, 'status', '${status}', 'progress', '${progress}'${source ? `, 'source', '${source}'` : ''})));`
const addEpisode = `INSERT INTO content_sources(content_item_id, platform, link, external_id, is_primary)
  SELECT id, 'Askwho Casts', 'https://app.askwhocasts.com/f/x/' || id || '.mp3', 'askwhocasts:' || id, false FROM fixture;`
const addConversion = (status: string) => `INSERT INTO awc_conversions(content_item_id, source_url, status)
  SELECT id, 'https://ex.com/a', '${status}' FROM fixture;`

function scenario(body: string) {
  const output = sql(`BEGIN;
    CREATE TEMP TABLE fixture ON COMMIT DROP AS WITH inserted AS (
      INSERT INTO content_items(title, author, kind, status, progress, status_changed_at)
      VALUES ('ITEST-364 ' || gen_random_uuid(), 'ITEST-364', 'feed', 'In Progress', '10', '2026-01-01')
      RETURNING id
    ) SELECT id FROM inserted;
    INSERT INTO content_sources(content_item_id, platform, link, external_id, is_primary)
      SELECT id, 'Spotify', 'https://open.spotify.com/episode/' || id, 'spotify:episode:' || id, true FROM fixture;
    ${body}
    SELECT row_to_json(c) FROM content_items c WHERE id = ${id};
    ROLLBACK;`)
  return JSON.parse(output.split('\n').filter(Boolean).at(-1)!)
}

describe.skipIf(!available)('Spotify progress on items with Askwho Casts audio (#364)', () => {
  it('ignores Spotify status and progress once an episode is attached', () => {
    expect(scenario(`${addEpisode} ${update('spotify')}`)).toMatchObject({ status: 'In Progress', progress: '10' })
  })
  it.each(['queued', 'starting', 'submitting_url', 'building_script', 'generating'])(
    'ignores them while a conversion is %s', (status) => {
      expect(scenario(`${addConversion(status)} ${update('spotify')}`)).toMatchObject({ status: 'In Progress', progress: '10' })
    },
  )
  it.each(['done', 'failed'])('applies them when the only conversion is %s and no episode is attached', (status) => {
    expect(scenario(`${addConversion(status)} ${update('spotify')}`)).toMatchObject({ status: 'Completed', progress: '100' })
  })
  it('still completes an ordinary Spotify item', () => {
    expect(scenario(update('spotify'))).toMatchObject({ status: 'Completed', progress: '100' })
  })
  it('still completes through Apple Podcasts, which sends no source', () => {
    expect(scenario(`${addEpisode} ${update(null)}`)).toMatchObject({ status: 'Completed', progress: '100' })
  })
  it('skips only the matching entry in a batch', () => {
    const row = scenario(`${addEpisode} SELECT apply_spotify_progress(jsonb_build_array(
      jsonb_build_object('id', ${id}, 'status', 'Completed', 'progress', '100', 'source', 'spotify'),
      jsonb_build_object('id', ${id}, 'status', 'In Progress', 'progress', '40')));`)
    expect(row).toMatchObject({ status: 'In Progress', progress: '40' })
  })
  // #368: a comments episode isn't the article's audio, so the article's
  // Spotify listen still counts.
  it('applies them when the only Askwho source is a comments episode', () => {
    const addComments = `INSERT INTO content_sources(content_item_id, platform, link, external_id, is_primary, source_label)
      SELECT id, 'Askwho Casts', 'https://app.askwhocasts.com/f/x/c' || id || '.mp3', 'askwhocasts:c' || id, false, 'Comments' FROM fixture;`
    expect(scenario(`${addComments} ${update('spotify')}`)).toMatchObject({ status: 'Completed', progress: '100' })
  })
  it('applies them while a comments conversion is active', () => {
    const addCommentsRequest = `INSERT INTO awc_conversions(content_item_id, source_url, status, kind)
      SELECT id, 'https://www.lesswrong.com/posts/a/b#comments', 'generating', 'comments' FROM fixture;`
    expect(scenario(`${addCommentsRequest} ${update('spotify')}`)).toMatchObject({ status: 'Completed', progress: '100' })
  })
  it('still rejects an invalid status from Spotify', () => {
    expect(() => scenario(`${addEpisode} ${update('spotify', 'Skip')}`)).toThrow(/Invalid Spotify status/)
  })
})
