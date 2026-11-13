/**
 * Shared CLI plumbing for the backfill apply scripts (#167 feed cards, #168 book
 * covers): load .env.local, guard against accidental non-local (PROD) writes, and
 * parse the common --write / --force / --limit=N flags.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Load .env.local into process.env (no-op if the file is missing). Existing env
 * vars win, so an explicit `SUPABASE_URL=…` export still targets local.
 * Call this BEFORE importing lib/supabase (which reads env at import time).
 */
export function loadEnvIntoProcess() {
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

/** True when the Supabase URL points at a local instance (guards PROD writes). */
export function isLocalTarget(url: string): boolean {
  return /(localhost|127\.0\.0\.1)/.test(url)
}

export interface BackfillFlags {
  write: boolean
  force: boolean
  limit?: number
}

/** Parse the shared backfill flags from argv (e.g. process.argv.slice(2)). */
export function parseBackfillFlags(argv: string[]): BackfillFlags {
  const write = argv.includes('--write')
  const force = argv.includes('--force')
  const limitArg = argv.find((a) => a.startsWith('--limit='))
  const limit = limitArg ? Number(limitArg.split('=')[1]) : undefined
  return { write, force, limit }
}
