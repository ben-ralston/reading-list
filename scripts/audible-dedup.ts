/**
 * Audible ↔ Goodreads book dedup — runner (#42).
 *
 * Finds the duplicate book pairs created before the base-title matcher landed
 * (Audible "base" title vs Goodreads "full" title with a subtitle/series
 * suffix) and merges each pair: keep the Goodreads row, attach the Audible
 * source to it, reconcile status/position, drop the orphan Audible row.
 *
 *   # dry run (default — no writes), prints the plan:
 *   pnpm dlx tsx scripts/audible-dedup.ts
 *   # commit the merges:
 *   pnpm dlx tsx scripts/audible-dedup.ts --write
 *
 * Target DB defaults to .env.local (PROD). The planning logic is the pure,
 * unit-tested planAudibleDedup() in lib/sync/audible-dedup.ts; this script only
 * fetches, prints, and (with --write) applies. Idempotent: a second run finds
 * nothing because the orphan rows are gone and the source is already attached.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { planAudibleDedup, type DedupItem } from '../lib/sync/audible-dedup'

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

function resolveSupabaseUrl(): string {
  if (process.env.SUPABASE_URL) return process.env.SUPABASE_URL
  const pg = process.env.POSTGRES_URL
  const ref = pg?.match(/postgres\.([^:]+):/)?.[1]
  if (!ref) {
    console.error('Cannot resolve Supabase URL (set SUPABASE_URL or POSTGRES_URL).')
    process.exit(1)
  }
  return `https://${ref}.supabase.co`
}

async function main() {
  loadEnvIntoProcess()
  const write = process.argv.includes('--write')

  const url = resolveSupabaseUrl()
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) {
    console.error('Missing SUPABASE_SERVICE_ROLE_KEY.')
    process.exit(1)
  }
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  console.log(`Target: ${url}`)
  console.log(write ? '=== WRITE MODE — changes will be applied ===\n' : '=== DRY RUN (pass --write to apply) ===\n')

  const { data, error } = await supabase
    .from('content_items')
    .select('id, title, author, kind, status, queue_position, position_confirmed, progress, sources:content_sources(id, platform, external_id, link, is_primary)')
    .eq('kind', 'book')

  if (error) {
    console.error('Fetch failed:', error)
    process.exit(1)
  }

  const items = (data ?? []) as unknown as DedupItem[]
  const { merges, skipped } = planAudibleDedup(items)

  console.log(`Books: ${items.length} | merge pairs: ${merges.length} | flagged groups: ${skipped.length}\n`)

  for (const m of merges) {
    console.log(`MERGE  keep #${m.keepId} "${m.keepTitle}"`)
    console.log(`       drop #${m.dropId} "${m.dropTitle}" (${m.author})`)
    console.log(`       move source ids [${m.movedSourceIds.join(', ')}] → #${m.keepId}` +
      (m.newStatus ? `, status → ${m.newStatus}` : '') +
      (m.clearPosition ? ', clear queue_position' : '') +
      (m.newProgress ? `, progress → ${m.newProgress}` : ''))
  }
  if (skipped.length) {
    console.log('\nFLAGGED (manual review — not auto-merged):')
    for (const s of skipped) console.log(`  - ${s.baseKey} [${s.itemIds.join(', ')}] — ${s.reason}`)
  }

  if (!write) {
    console.log('\nDry run complete. Re-run with --write to apply the merges above.')
    return
  }

  let applied = 0
  for (const m of merges) {
    // 1. Re-point the Audible source(s) onto the keeper as non-primary.
    for (const srcId of m.movedSourceIds) {
      const { error: mvErr } = await supabase
        .from('content_sources')
        .update({ content_item_id: m.keepId, is_primary: false })
        .eq('id', srcId)
      if (mvErr) { console.error(`  move source ${srcId} failed:`, mvErr); process.exit(1) }
    }

    // 2. Reconcile keeper status / position / progress.
    const updates: Record<string, unknown> = {}
    if (m.newStatus !== null) {
      updates.status = m.newStatus
      updates.status_changed_at = new Date().toISOString()
    }
    if (m.clearPosition) {
      updates.queue_position = null
      updates.position_confirmed = false
    }
    if (m.newProgress !== null) updates.progress = m.newProgress
    if (Object.keys(updates).length > 0) {
      const { error: upErr } = await supabase.from('content_items').update(updates).eq('id', m.keepId)
      if (upErr) { console.error(`  update keeper ${m.keepId} failed:`, upErr); process.exit(1) }
    }

    // 3. Delete the orphan Audible row (its sources have been re-pointed away).
    //    Defensive: clear any remaining sources first to satisfy the FK.
    await supabase.from('content_sources').delete().eq('content_item_id', m.dropId)
    const { error: delErr } = await supabase.from('content_items').delete().eq('id', m.dropId)
    if (delErr) { console.error(`  delete item ${m.dropId} failed:`, delErr); process.exit(1) }

    applied++
    console.log(`  ✓ merged #${m.dropId} → #${m.keepId}`)
  }

  console.log(`\nApplied ${applied} merge(s).`)
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1) })
