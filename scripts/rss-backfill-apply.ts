/**
 * RSS backfill — apply a selection (WRITER).
 *
 * Reads the selection JSON produced by the preview UI and creates the missing
 * content_items (attaching the feed source to any post that turns out to already
 * match). Idempotent and dedup-safe: every post is matched first, so a re-run
 * creates nothing.
 *
 *   # dry run (default — no writes), prints what would happen:
 *   pnpm dlx tsx scripts/rss-backfill-apply.ts
 *   # commit:
 *   pnpm dlx tsx scripts/rss-backfill-apply.ts --write
 *
 * Target DB defaults to .env.local (PROD). For local testing export
 * SUPABASE_URL=http://127.0.0.1:54321 + SUPABASE_SERVICE_ROLE_KEY first.
 * The script refuses to write if the selection's recorded target differs from
 * the current target (use --force to override).
 *
 * Note: this does NOT generate AI summaries (the cron does that via Next.js
 * `after()`). Run scripts/backfill-summaries.ts afterward if you want them.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ApplyAction, BackfillPost } from '../lib/sync/backfill'

const SELECTION_PATH = 'scratch/rss-backfill-selection.json'

interface SelectionFeed {
  feedId: number
  label: string
  platform: string
  cutoffDate: string | null
  posts: BackfillPost[]
}
interface Selection {
  generatedAt: string
  target: string
  totalPosts: number
  feeds: SelectionFeed[]
}

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

async function main() {
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const force = args.includes('--force')

  loadEnvIntoProcess()

  const selection: Selection = JSON.parse(readFileSync(resolve(SELECTION_PATH), 'utf8'))
  if (!selection.feeds?.length) {
    console.log('Selection is empty — nothing to do.')
    return
  }

  const { applyBackfillSelection } = await import('../lib/sync/backfill')
  const { supabase, supabaseUrl } = await import('../lib/supabase')

  console.log('='.repeat(64))
  console.log(`RSS backfill apply — ${write ? 'WRITE' : 'DRY RUN'}`)
  console.log(`Target now:        ${supabaseUrl}`)
  console.log(`Selection target:  ${selection.target}`)
  console.log(`Selection made at: ${selection.generatedAt}`)
  console.log(`Feeds: ${selection.feeds.length} · Posts selected: ${selection.totalPosts}`)
  console.log('='.repeat(64))

  if (write && selection.target !== supabaseUrl && !force) {
    console.error(
      `\nREFUSING TO WRITE: selection was generated against ${selection.target} ` +
        `but the current target is ${supabaseUrl}.\n` +
        `Re-run the preview against this DB, or pass --force if this is intentional.`
    )
    process.exit(1)
  }

  const totals: Record<ApplyAction, number> = {
    created: 0,
    'source-attached': 0,
    unchanged: 0,
    'skipped-ambiguous': 0,
  }

  for (const feed of selection.feeds) {
    const results = await applyBackfillSelection(feed.posts, supabase, { dryRun: !write })
    const counts: Record<ApplyAction, number> = {
      created: 0,
      'source-attached': 0,
      unchanged: 0,
      'skipped-ambiguous': 0,
    }
    for (const r of results) {
      counts[r.action]++
      totals[r.action]++
    }
    const tag = write ? '' : '[dry] '
    console.log(
      `\n[${feed.label}] from ${feed.cutoffDate ?? '—'} → today  (${feed.posts.length} selected)`
    )
    console.log(
      `  ${tag}created ${counts.created} · source-attached ${counts['source-attached']} · ` +
        `unchanged ${counts.unchanged} · skipped-ambiguous ${counts['skipped-ambiguous']}`
    )
    for (const r of results) {
      if (r.action === 'created' || r.action === 'skipped-ambiguous') {
        const id = r.contentItemId ? `#${r.contentItemId} ` : ''
        console.log(`    ${write ? r.action.toUpperCase() : '[would] ' + r.action} ${id}${r.item.title}`)
      }
    }
  }

  console.log('\n' + '='.repeat(64))
  console.log(`${write ? 'Applied' : 'Would apply'}:`)
  console.log(`  created:           ${totals.created}`)
  console.log(`  source-attached:   ${totals['source-attached']}`)
  console.log(`  unchanged:         ${totals.unchanged}`)
  console.log(`  skipped-ambiguous: ${totals['skipped-ambiguous']}`)
  if (!write) {
    console.log('\nDRY RUN — no writes performed. Re-run with --write to commit.')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
