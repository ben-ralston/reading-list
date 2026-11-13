/**
 * Spotify show-name backfill — populate content_sources.source_label (#245).
 *
 * Since #237 an item can carry several Spotify episode rows, which the source
 * menus render as identical "Open on Spotify" entries. The show name is what
 * tells them apart, so this backfills source_label for existing Spotify episode
 * rows that predate the column.
 *
 *   # read-only report (default): how many rows still need a label
 *   pnpm dlx tsx scripts/spotify-show-backfill.ts            # or --preview
 *   # commit (needs a live Spotify token — see #219 runbook):
 *   pnpm dlx tsx scripts/spotify-show-backfill.ts --apply
 *
 * Preview performs NO Spotify calls and NO writes — safe against prod anytime.
 * Apply fetches show names via the Spotify API (50 episodes/request) and updates
 * each row by id. Idempotent: only rows with a NULL source_label are touched, so
 * a re-run relabels nothing.
 *
 * Target DB defaults to .env.local (PROD). For local testing export
 * SUPABASE_URL=http://127.0.0.1:54321 + SUPABASE_SERVICE_ROLE_KEY first.
 * Writing to a non-local target requires --force, so an --apply can't hit prod
 * by accident.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const EPISODE_PREFIX = 'spotify:episode:'

function loadEnvIntoProcess() {
  let raw: string
  try {
    raw = readFileSync(resolve('.env.local'), 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    const key = t.slice(0, eq).trim()
    if (key in process.env) continue
    let v = t.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    process.env[key] = v
  }
}

interface UnlabeledRow {
  id: number
  external_id: string
}

async function main() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const force = args.includes('--force')

  loadEnvIntoProcess()

  const { supabase, supabaseUrl } = await import('../lib/supabase')
  const isLocal = /localhost|127\.0\.0\.1/.test(supabaseUrl)

  console.log('='.repeat(64))
  console.log(`Spotify show-name backfill — ${apply ? 'APPLY' : 'PREVIEW'}`)
  console.log(`Target: ${supabaseUrl}${isLocal ? ' (local)' : ' (REMOTE)'}`)
  console.log('='.repeat(64))

  // Every Spotify episode row that still lacks a label.
  const { data, error } = await supabase
    .from('content_sources')
    .select('id, external_id')
    .eq('platform', 'Spotify')
    .is('source_label', null)
    .like('external_id', `${EPISODE_PREFIX}%`)

  if (error) {
    console.error('Error querying content_sources:', error)
    process.exit(1)
  }

  const rows = (data ?? []) as UnlabeledRow[]
  // Group row ids by bare episode id so one API result labels all its rows.
  const rowsByEpisodeId = new Map<string, number[]>()
  for (const row of rows) {
    const episodeId = row.external_id.slice(EPISODE_PREFIX.length)
    if (!episodeId) continue
    const list = rowsByEpisodeId.get(episodeId)
    if (list) list.push(row.id)
    else rowsByEpisodeId.set(episodeId, [row.id])
  }
  const episodeIds = [...rowsByEpisodeId.keys()]
  const apiCalls = Math.ceil(episodeIds.length / 50)

  console.log(`Unlabeled Spotify episode rows: ${rows.length}`)
  console.log(`Distinct episodes to resolve:   ${episodeIds.length}  (~${apiCalls} API call(s))`)

  if (!apply) {
    console.log('\nPREVIEW — no Spotify calls, no writes. Re-run with --apply to commit.')
    return
  }

  if (!isLocal && !force) {
    console.error(
      `\nREFUSING TO WRITE to a remote target (${supabaseUrl}).\n` +
        `Pass --force if backfilling prod is intentional.`
    )
    process.exit(1)
  }

  if (episodeIds.length === 0) {
    console.log('\nNothing to label — every Spotify episode row already has a source_label.')
    return
  }

  const { getAccessToken } = await import('../lib/spotify/auth')
  const { fetchEpisodesByIds } = await import('../lib/spotify/client')
  const { spotifyShowLabel, normalizeShowName } = await import('../lib/spotify/transform')

  const accessToken = await getAccessToken()
  const showByEpisodeId = await fetchEpisodesByIds(episodeIds, accessToken)

  let labeled = 0
  let skippedNoShow = 0
  let updateErrors = 0

  for (const [episodeId, ids] of rowsByEpisodeId) {
    // Normalize exactly as the live spotify-sync path does (syncItem.author is
    // normalizeShowName(show.name)); otherwise the backfill would store the raw
    // "Astral Codex Ten Podcast" and the next live sync's stale-label update
    // would immediately overwrite it with "Astral Codex Ten" (#245 review).
    const label = spotifyShowLabel(normalizeShowName(showByEpisodeId.get(episodeId)))
    if (!label) {
      skippedNoShow += ids.length
      continue
    }
    const { error: updateError } = await supabase
      .from('content_sources')
      .update({ source_label: label })
      .in('id', ids)
    if (updateError) {
      console.error(`  Error labeling episode ${episodeId}:`, updateError.message)
      updateErrors += ids.length
      continue
    }
    labeled += ids.length
  }

  console.log('\n' + '='.repeat(64))
  console.log(`Labeled rows:        ${labeled}`)
  console.log(`Skipped (no show):   ${skippedNoShow}`)
  console.log(`Update errors:       ${updateErrors}`)
  console.log('='.repeat(64))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
