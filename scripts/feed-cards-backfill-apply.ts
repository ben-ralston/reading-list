/**
 * Feed-card backfill — apply (WRITER).
 *
 * Scrapes each feed item that lacks a thumbnail for an og:image (and word count)
 * and writes it to content_items. Idempotent: enriched rows gain an image_url and
 * drop out of the selection, so a re-run produces 0 writes for everything that
 * succeeded.
 *
 *   # dry run (default — scrapes but no writes), prints what would change:
 *   pnpm dlx tsx scripts/feed-cards-backfill-apply.ts
 *   # commit:
 *   pnpm dlx tsx scripts/feed-cards-backfill-apply.ts --write
 *
 * Target DB defaults to .env.local (PROD). For local testing export
 * SUPABASE_URL=http://127.0.0.1:54321 + SUPABASE_SERVICE_ROLE_KEY first.
 * Writing to a NON-LOCAL target requires --force (guards against accidental
 * PROD writes). Optional --limit=N caps the batch.
 */

import type { BackfillEnrichAction } from '../lib/sync/feed-cards-backfill'
import { loadEnvIntoProcess, isLocalTarget, parseBackfillFlags } from './backfill-cli'

async function main() {
  const { write, force, limit } = parseBackfillFlags(process.argv.slice(2))

  loadEnvIntoProcess()

  const { findFeedItemsNeedingImage, enrichFeedItems } = await import('../lib/sync/feed-cards-backfill')
  const { supabase, supabaseUrl } = await import('../lib/supabase')

  console.log('='.repeat(64))
  console.log(`Feed-card backfill apply — ${write ? 'WRITE' : 'DRY RUN'}`)
  console.log(`Target: ${supabaseUrl}`)
  if (limit) console.log(`Limit:  ${limit}`)
  console.log('='.repeat(64))

  if (write && !isLocalTarget(supabaseUrl) && !force) {
    console.error(
      `\nREFUSING TO WRITE to a non-local target (${supabaseUrl}).\n` +
        `Re-run against local Supabase, or pass --force if writing to PROD is intentional.`,
    )
    process.exit(1)
  }

  const rows = await findFeedItemsNeedingImage(supabase, limit)
  console.log(`\nFeed items missing a thumbnail: ${rows.length}`)
  if (rows.length === 0) {
    console.log('Nothing to do.')
    return
  }

  const results = await enrichFeedItems(rows, supabase, { dryRun: !write, concurrency: 5 })

  const totals: Record<BackfillEnrichAction, number> = {
    enriched: 0,
    'no-image-found': 0,
    'no-link': 0,
    failed: 0,
  }
  for (const r of results) {
    totals[r.action]++
    if (r.action === 'enriched') {
      const tag = write ? 'ENRICHED' : '[would] enriched'
      console.log(`  ${tag} #${r.id} ${r.title}  ${r.imageUrl ?? ''}`)
    }
  }

  console.log('\n' + '='.repeat(64))
  console.log(`${write ? 'Applied' : 'Would apply'}:`)
  console.log(`  enriched:        ${totals.enriched}`)
  console.log(`  no-image-found:  ${totals['no-image-found']}`)
  console.log(`  no-link:         ${totals['no-link']}`)
  console.log(`  failed:          ${totals.failed}`)
  if (!write) {
    console.log('\nDRY RUN — no writes performed. Re-run with --write to commit.')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
