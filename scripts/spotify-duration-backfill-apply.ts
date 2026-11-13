/**
 * Spotify episode duration backfill — apply (WRITER). (#194)
 *
 * Fetches each episode's duration from the Spotify Web API (single-get, by the
 * source's spotify:episode:* external_id) for content items whose
 * duration_seconds is NULL and writes it. Idempotent: filled rows drop out of
 * the selection, so a re-run produces 0 writes for everything that succeeded.
 *
 *   # dry run (default — fetches but no writes), prints what would change:
 *   pnpm dlx tsx scripts/spotify-duration-backfill-apply.ts
 *   # commit:
 *   pnpm dlx tsx scripts/spotify-duration-backfill-apply.ts --write
 *
 * Target DB defaults to .env.local (PROD). For local testing export
 * SUPABASE_URL=http://127.0.0.1:54321 + SUPABASE_SERVICE_ROLE_KEY first.
 * Writing to a NON-LOCAL target requires --force (guards against accidental
 * PROD writes). Optional --limit=N caps the batch.
 */

import type { DurationFillAction } from '../lib/sync/spotify-duration-backfill'
import { loadEnvIntoProcess, isLocalTarget, parseBackfillFlags } from './backfill-cli'

async function main() {
  const { write, force, limit } = parseBackfillFlags(process.argv.slice(2))

  loadEnvIntoProcess()

  const { findItemsNeedingDuration, fillDurations } = await import(
    '../lib/sync/spotify-duration-backfill'
  )
  const { getAccessToken } = await import('../lib/spotify/auth')
  const { supabase, supabaseUrl } = await import('../lib/supabase')

  console.log('='.repeat(64))
  console.log(`Spotify duration backfill apply — ${write ? 'WRITE' : 'DRY RUN'}`)
  console.log(`Target: ${supabaseUrl}`)
  if (limit) console.log(`Limit:  ${limit}`)
  console.log('='.repeat(64))

  if (write && !isLocalTarget(supabaseUrl) && !force) {
    console.error(
      `\nREFUSING TO WRITE to a non-local target (${supabaseUrl}).\n` +
        `Re-run against local Supabase, or pass --force if writing to PROD is intentional.`
    )
    process.exit(1)
  }

  const rows = await findItemsNeedingDuration(supabase, limit)
  console.log(`\nItems needing a duration: ${rows.length}`)
  if (rows.length === 0) {
    console.log('Nothing to do.')
    return
  }

  const accessToken = await getAccessToken()
  const results = await fillDurations(rows, accessToken, supabase, {
    dryRun: !write,
    concurrency: 3,
  })

  const totals: Record<DurationFillAction, number> = {
    filled: 0,
    'episode-not-found': 0,
    failed: 0,
  }
  for (const r of results) {
    totals[r.action]++
    if (r.action === 'filled') {
      const tag = write ? 'FILLED' : '[would] filled'
      console.log(`  ${tag} #${r.contentItemId} ${r.title}  ${r.durationSeconds}s`)
    } else if (r.action === 'episode-not-found') {
      console.log(`  not-found  #${r.contentItemId} ${r.title}`)
    }
  }

  console.log('\n' + '='.repeat(64))
  console.log(`${write ? 'Applied' : 'Would apply'}:`)
  console.log(`  filled:            ${totals.filled}`)
  console.log(`  episode-not-found: ${totals['episode-not-found']}`)
  console.log(`  failed:            ${totals.failed}`)
  if (!write) {
    console.log('\nDRY RUN — no writes performed. Re-run with --write to commit.')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
