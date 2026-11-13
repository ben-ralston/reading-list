/**
 * Spotify back-catalog cleanup (#305) — removes a show's never-touched
 * back-catalog imports and closes the queue gaps they leave.
 *
 * Selection (lib/sync/spotify-backcatalog-cleanup.ts): feed items by one of the
 * given shows, created at/after --imported-since, published before
 * --published-before, created by the sync (added_by 'spotify'), status '' with
 * no progress and no confirmed position. Removal goes through the
 * remove_content_items RPC: one transaction, sources deleted first, gaps
 * closed, multi-row writer lock held, and any row changed since this script
 * read it is skipped.
 *
 * ORDER MATTERS for a PROD run: (1) deploy the app so spotify-sync has the
 * back-catalog guard, (2) `./run deploy` migration 20260928000000, THEN (3) run
 * this with --write. The removed episodes are still in Spotify saved episodes;
 * without the guard live, the next sync re-imports them (and re-fires a
 * summary for each).
 *
 *   # dry run (default — read-only), lists what would be removed:
 *   pnpm dlx tsx scripts/spotify-backcatalog-cleanup.ts \
 *     --show="This American Life Partners" \
 *     --imported-since=2026-09-23T00:00:00Z --published-before=2026-09-01T00:00:00Z
 *   # commit: add --write (and --force for a non-local target, i.e. PROD)
 *
 * Target DB defaults to .env.local (PROD). For local testing export
 * SUPABASE_URL=http://127.0.0.1:54321 + SUPABASE_SERVICE_ROLE_KEY first.
 */

import { loadEnvIntoProcess, isLocalTarget, parseBackfillFlags } from './backfill-cli'

function flagValues(argv: string[], name: string): string[] {
  return argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3))
}

function requireInstant(argv: string[], name: string): string {
  const [value] = flagValues(argv, name)
  if (!value || Number.isNaN(Date.parse(value))) {
    console.error(`Missing or invalid --${name}=<ISO timestamp>`)
    process.exit(1)
  }
  return value
}

async function main() {
  const argv = process.argv.slice(2)
  const { write, force } = parseBackfillFlags(argv)
  const shows = flagValues(argv, 'show').filter((s) => s.trim() !== '')
  if (shows.length === 0) {
    console.error('At least one --show=<content_items.author> is required')
    process.exit(1)
  }
  const criteria = {
    shows,
    importedSince: requireInstant(argv, 'imported-since'),
    publishedBefore: requireInstant(argv, 'published-before'),
  }

  loadEnvIntoProcess()

  const { findBackCatalogImports } = await import('../lib/sync/spotify-backcatalog-cleanup')
  const { supabase, supabaseUrl } = await import('../lib/supabase')

  console.log('='.repeat(64))
  console.log(`Spotify back-catalog cleanup — ${write ? 'WRITE' : 'DRY RUN'}`)
  console.log(`Target:           ${supabaseUrl}`)
  console.log(`Shows:            ${shows.join(', ')}`)
  console.log(`Imported since:   ${criteria.importedSince}`)
  console.log(`Published before: ${criteria.publishedBefore}`)
  console.log('='.repeat(64))

  if (write && !isLocalTarget(supabaseUrl) && !force) {
    console.error(
      `\nREFUSING TO WRITE to a non-local target (${supabaseUrl}).\n` +
        `Re-run against local Supabase, or pass --force if writing to PROD is intentional.`
    )
    process.exit(1)
  }

  const rows = await findBackCatalogImports(supabase, criteria)
  for (const r of rows) {
    console.log(
      `  ${write ? 'REMOVE' : '[would] remove'} #${r.id} pos=${r.queue_position ?? '-'} ` +
        `${r.published_on?.slice(0, 10)}  ${r.title}`
    )
  }
  console.log(`\nMatched: ${rows.length} item(s), ${rows.filter((r) => r.queue_position !== null).length} queued`)

  if (!write) {
    console.log('\nDRY RUN — no writes performed. Re-run with --write to commit.')
    return
  }
  if (rows.length === 0) {
    console.log('Nothing to do.')
    return
  }

  const { data, error } = await supabase.rpc('remove_content_items', {
    p_ids: rows.map((r) => r.id),
    p_expected_updated_at: rows.map((r) => r.updated_at),
  })
  if (error) throw error
  console.log(`Removed: ${data} item(s); queue gaps closed.`)
  if (data !== rows.length) {
    console.log(`Left alone: ${rows.length - data} item(s) changed since selection.`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
