/**
 * One-time script to generate AI summaries for active queue items.
 * Only targets items with queue_position set and status not Completed/Skip.
 *
 * Usage: pnpm tsx scripts/backfill-summaries.ts
 */
import { supabase } from '../lib/supabase'
import { generateSummary } from '../lib/summary'

async function main() {
  // Fetch active queue items without summaries
  const { data: items, error } = await supabase
    .from('content_items')
    .select('id, title')
    .is('summary', null)
    .not('queue_position', 'is', null)
    .not('status', 'in', '("Completed","Skip")')
    .order('queue_position', { ascending: true })

  if (error) {
    console.error('Failed to fetch items:', error)
    process.exit(1)
  }

  console.log(`Found ${items.length} items without summaries`)

  let success = 0
  let failed = 0

  for (const item of items) {
    try {
      console.log(`[${success + failed + 1}/${items.length}] Generating summary for "${item.title}"...`)
      await generateSummary(item.id)
      success++
      // Rate limit: 1 per second
      await new Promise(resolve => setTimeout(resolve, 1000))
    } catch (err) {
      console.error(`  Failed: ${err instanceof Error ? err.message : err}`)
      failed++
    }
  }

  console.log(`\nDone! Success: ${success}, Failed: ${failed}`)
}

main()
