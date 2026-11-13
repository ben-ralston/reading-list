/**
 * Book-cover backfill — apply (WRITER).
 *
 * Resolves a cover (via Open Library / Google Books, by title+author) for each
 * book that lacks one and writes image_url (+ isbn13 when newly found) to
 * content_items. Idempotent: enriched rows gain an image_url and drop out of the
 * selection, so a re-run produces 0 writes for everything that succeeded.
 *
 *   # dry run (default — resolves but no writes), prints what would change:
 *   pnpm dlx tsx scripts/book-covers-backfill-apply.ts
 *   # commit:
 *   pnpm dlx tsx scripts/book-covers-backfill-apply.ts --write
 *
 * Target DB defaults to .env.local (PROD). For local testing export
 * SUPABASE_URL=http://127.0.0.1:54321 + SUPABASE_SERVICE_ROLE_KEY first.
 * Writing to a NON-LOCAL target requires --force (guards against accidental
 * PROD writes). Optional --limit=N caps the batch.
 */

import type { BookCoverAction } from '../lib/sync/book-covers-backfill'
import { loadEnvIntoProcess, isLocalTarget, parseBackfillFlags } from './backfill-cli'

async function main() {
  const { write, force, limit } = parseBackfillFlags(process.argv.slice(2))

  loadEnvIntoProcess()

  const { findBooksNeedingCover, enrichBooks } = await import('../lib/sync/book-covers-backfill')
  const { supabase, supabaseUrl } = await import('../lib/supabase')

  console.log('='.repeat(64))
  console.log(`Book-cover backfill apply — ${write ? 'WRITE' : 'DRY RUN'}`)
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

  const rows = await findBooksNeedingCover(supabase, limit)
  const toReplace = rows.filter((r) => r.imageUrl != null).length
  console.log(`\nBooks needing a cover: ${rows.length} (missing: ${rows.length - toReplace}, hot-link-blocked to replace: ${toReplace})`)
  if (rows.length === 0) {
    console.log('Nothing to do.')
    return
  }

  const results = await enrichBooks(rows, supabase, { dryRun: !write, concurrency: 5 })

  const totals: Record<BookCoverAction, number> = {
    enriched: 0,
    'no-cover-found': 0,
    failed: 0,
  }
  for (const r of results) {
    totals[r.action]++
    if (r.action === 'enriched') {
      const tag = write ? 'ENRICHED' : '[would] enriched'
      const isbnNote = r.isbn13 ? `  (isbn13 ${r.isbn13})` : ''
      console.log(`  ${tag} #${r.id} ${r.title}  ${r.imageUrl ?? ''}  [${r.source}]${isbnNote}`)
    } else if (r.action === 'no-cover-found') {
      console.log(`  no-cover  #${r.id} ${r.title}`)
    }
  }

  console.log('\n' + '='.repeat(64))
  console.log(`${write ? 'Applied' : 'Would apply'}:`)
  console.log(`  enriched:        ${totals.enriched}`)
  console.log(`  no-cover-found:  ${totals['no-cover-found']}`)
  console.log(`  failed:          ${totals.failed}`)
  if (!write) {
    console.log('\nDRY RUN — no writes performed. Re-run with --write to commit.')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
