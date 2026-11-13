/**
 * #304: regenerate AI summaries in the structured (one-liner + bullets) format
 * for active queue items that don't have one yet. Idempotent: regenerated rows
 * gain summary_data and drop out of the selection.
 *
 *   pnpm dlx tsx scripts/regenerate-summaries.ts            # preview: count + cost
 *   pnpm dlx tsx scripts/regenerate-summaries.ts --write    # generate (local)
 *   ... --write --force                                     # generate against PROD
 *   ... --limit=20                                          # cap the batch
 *
 * Target DB defaults to .env.local (PROD). For local, export
 * SUPABASE_URL=http://127.0.0.1:54321 + SUPABASE_SERVICE_ROLE_KEY first.
 * Run against PROD only after #305 removes the TAL back catalog, and after
 * checking the Anthropic spend limit: the key is shared with prod.
 */
import { loadEnvIntoProcess, isLocalTarget, parseBackfillFlags } from './backfill-cli'

const EST_COST_PER_SUMMARY = 0.28 // measured, #304 round 2 (Opus 5.5)

async function main() {
  const { write, force, limit } = parseBackfillFlags(process.argv.slice(2))
  loadEnvIntoProcess()

  const { supabase, supabaseUrl } = await import('../lib/supabase')
  const { generateSummary } = await import('../lib/summary')
  const { regenerateAll } = await import('../lib/summary-regenerate')

  console.log('='.repeat(64))
  console.log(`Summary regeneration (#304): ${write ? 'WRITE' : 'PREVIEW'}`)
  console.log(`Target: ${supabaseUrl}`)
  console.log('='.repeat(64))

  if (write && !isLocalTarget(supabaseUrl) && !force) {
    console.error(`\nREFUSING TO WRITE to a non-local target (${supabaseUrl}). Pass --force if intentional.`)
    process.exit(1)
  }

  let query = supabase
    .from('content_items')
    .select('id, title, queue_position')
    .in('status', ['', 'In Progress'])
    .neq('kind', 'book')
    .is('summary_data', null)
    .order('queue_position', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true })
  if (limit) query = query.limit(limit)

  const { data: items, error } = await query
  if (error) throw new Error(`Failed to fetch items: ${error.message}`)

  const n = items?.length ?? 0
  console.log(`\nItems needing a structured summary: ${n}`)
  console.log(`Estimated cost: ~$${(n * EST_COST_PER_SUMMARY).toFixed(2)} (at $${EST_COST_PER_SUMMARY}/summary)`)
  if (!write || n === 0) {
    if (!write) console.log('\nPreview only. Re-run with --write to generate.')
    return
  }

  const { ok, failed, notAttempted } = await regenerateAll(items ?? [], (id) => generateSummary(id))

  console.log(`\nDone: ${ok} ok, ${failed.length} failed, ${notAttempted} not attempted`)
  for (const f of failed) console.log(`  #${f.id} ${f.title}: ${f.error}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
