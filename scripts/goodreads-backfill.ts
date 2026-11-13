/**
 * Goodreads link backfill (#186 companion).
 *
 * Finds every book (content_items.kind='book') that has NO Goodreads source with
 * a link, runs the agentic parseBook lookup (lib/book-parser) on "<title>
 * <author>" to find the canonical /book/show/ URL, and attaches it as a
 * non-primary Goodreads content_sources row. Existing primary sources (Audible,
 * Physical, …) are untouched.
 *
 * Idempotent: only books still missing a Goodreads link are processed, so a
 * re-run is a no-op for already-linked books.
 *
 * Target DB defaults to whatever .env.local points at (PROD). Override for local
 * testing by exporting SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY first.
 *
 *   pnpm dlx tsx scripts/goodreads-backfill.ts            # DRY RUN (no writes)
 *   pnpm dlx tsx scripts/goodreads-backfill.ts --write    # apply
 *
 * Needs ANTHROPIC_API_KEY (for the lookup) in the environment / .env.local.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Populate process.env from .env.local WITHOUT clobbering already-set vars. */
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

function supabaseUrl(): string {
  if (process.env.SUPABASE_URL) return process.env.SUPABASE_URL
  const pg = process.env.POSTGRES_URL
  const m = pg?.match(/postgres\.([^:]+):/)
  if (!m) throw new Error('Cannot determine Supabase URL (set SUPABASE_URL or POSTGRES_URL)')
  return `https://${m[1]}.supabase.co`
}

/** goodreads.com/book/show/40121378-atomic-habits -> goodreads:book:40121378 */
function goodreadsExternalId(url: string): string | null {
  const m = url.match(/goodreads\.com\/book\/show\/(\d+)/i)
  return m ? `goodreads:book:${m[1]}` : null
}

interface SourceRow { platform: string | null; link: string | null }
interface BookRow {
  id: number
  title: string
  author: string | null
  status: string | null
  queue_position: number | null
  content_sources: SourceRow[]
}

function hasGoodreads(b: BookRow): boolean {
  return b.content_sources.some(
    (s) => (s.platform || '').toLowerCase() === 'goodreads' && (s.link || '').trim() !== '',
  )
}

async function main() {
  const WRITE = process.argv.includes('--write')
  loadEnvIntoProcess()

  const { createClient } = await import('@supabase/supabase-js')
  const url = supabaseUrl()
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY')
  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { parseBook } = await import('../lib/book-parser')

  console.log(`Target: ${url}`)
  console.log(`Mode:   ${WRITE ? 'WRITE (will insert Goodreads sources)' : 'DRY RUN (no writes)'}`)
  console.log()

  const { data, error } = await supabase
    .from('content_items')
    .select('id,title,author,status,queue_position,content_sources(platform,link)')
    .eq('kind', 'book')
    .order('queue_position', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true })
  if (error) throw error

  const books = (data || []) as unknown as BookRow[]
  const missing = books.filter((b) => !hasGoodreads(b))
  console.log(`Books: ${books.length} total, ${missing.length} missing a Goodreads link.\n`)

  const results: { id: number; title: string; url?: string; confidence: string }[] = []
  for (const b of missing) {
    const meta = await parseBook(`${b.title} ${b.author || ''}`.trim())
    results.push({ id: b.id, title: b.title, url: meta.goodreadsUrl, confidence: meta.confidence })
    const status = meta.goodreadsUrl ? meta.goodreadsUrl : '*** NOT FOUND ***'
    console.log(`  ${b.id} [${meta.confidence}] ${b.title} — ${b.author || ''}`)
    console.log(`        -> ${status}`)
  }

  const found = results.filter((r) => r.url)
  console.log(`\nFound Goodreads URLs for ${found.length}/${missing.length} books.`)

  if (!WRITE) {
    console.log('\nDRY RUN — nothing written. Re-run with --write to apply.')
    return
  }

  console.log('\nWriting Goodreads sources...')
  let ok = 0
  for (const r of found) {
    const { error: insErr } = await supabase.from('content_sources').insert({
      content_item_id: r.id,
      platform: 'Goodreads',
      link: r.url,
      is_primary: false,
      external_id: goodreadsExternalId(r.url!),
    })
    if (insErr) {
      console.error(`  ${r.id} FAILED: ${insErr.message}`)
    } else {
      ok++
      console.log(`  ${r.id} OK -> ${r.url}`)
    }
  }
  console.log(`\nDone. Inserted ${ok}/${found.length} Goodreads sources.`)
  const stillMissing = results.length - found.length
  if (stillMissing > 0) {
    console.log(`${stillMissing} book(s) had no Goodreads URL found — left untouched.`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
