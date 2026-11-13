/**
 * Feed-card backfill — preview (READ-ONLY).
 *
 * Reports how many feed items still lack a preview thumbnail (image_url) and how
 * many of those have a usable source link to scrape. Performs no network scrapes
 * and no writes — it's a quick "how much work is there" report before running
 * the apply script.
 *
 *   pnpm dlx tsx scripts/feed-cards-backfill-preview.ts
 *
 * Target DB defaults to .env.local (PROD). For local testing export
 * SUPABASE_URL=http://127.0.0.1:54321 + SUPABASE_SERVICE_ROLE_KEY first.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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
  loadEnvIntoProcess()

  const { findFeedItemsNeedingImage } = await import('../lib/sync/feed-cards-backfill')
  const { supabase, supabaseUrl } = await import('../lib/supabase')

  const rows = await findFeedItemsNeedingImage(supabase)
  const withLink = rows.filter((r) => r.link && /^https?:\/\//.test(r.link))
  const withoutLink = rows.length - withLink.length

  console.log('='.repeat(64))
  console.log('Feed-card backfill — PREVIEW (read-only)')
  console.log(`Target: ${supabaseUrl}`)
  console.log('='.repeat(64))
  console.log(`Feed items missing a thumbnail: ${rows.length}`)
  console.log(`  with a scrapable http(s) link: ${withLink.length}`)
  console.log(`  with no usable link (skipped): ${withoutLink}`)
  console.log('\nSample (first 10 with a link):')
  for (const r of withLink.slice(0, 10)) {
    console.log(`  #${r.id}  ${r.title}`)
  }
  console.log('\nRun scripts/feed-cards-backfill-apply.ts (dry run) to see what would change.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
