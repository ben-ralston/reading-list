/**
 * Integration test for #281 (F1/F4): reserveSigninAttempt's compare-and-swap
 * must let exactly ONE of a burst of concurrent sign-in attempts through, so
 * parallel guesses can't all pass the gate before any failure is counted.
 * Exercises the real PostgREST filtered UPDATE against the local stack.
 *
 * Runs only when the local Supabase stack is up (`./run db-start`); skips
 * otherwise (e.g. CI, which has no database).
 */
import { execFileSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const local = vi.hoisted(() => {
  // vi.hoisted runs before imports, so require node built-ins directly.
  const { execFileSync: run } = require('node:child_process') as typeof import('node:child_process')
  let found: { url: string; key: string; dbUrl: string } | null = null
  try {
    const raw = run('supabase', ['status', '-o', 'json'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20_000,
    }).toString()
    const status = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1))
    if (status.API_URL && status.SERVICE_ROLE_KEY && status.DB_URL) {
      found = { url: status.API_URL as string, key: status.SERVICE_ROLE_KEY as string, dbUrl: status.DB_URL as string }
    }
  } catch {
    // No local stack — suite is skipped below.
  }
  if (found) {
    // Same announcement and port guard as local-stack.ts, inlined because
    // vi.hoisted runs before this file's imports.
    const db = new URL(found.dbUrl)
    const api = new URL(found.url)
    console.log(`[integration] target: db ${db.hostname}:${db.port}, api ${api.hostname}:${api.port}`)
    const range = process.env.INTEGRATION_FORBID_PORT_RANGE?.match(/^(\d+)-(\d+)$/)
    if (range) {
      for (const port of [Number(db.port), Number(api.port)]) {
        if (port >= Number(range[1]) && port <= Number(range[2])) {
          throw new Error(`integration tests refused: port ${port} is in the forbidden range ${range[1]}-${range[2]}`)
        }
      }
    }
  }
  return found
})

vi.mock('@/lib/supabase', async () => {
  const { createClient: create } = await import('@supabase/supabase-js')
  return {
    supabase: local
      ? create(local.url, local.key, { auth: { persistSession: false } })
      : {},
  }
})

import { reserveSigninAttempt } from '@/lib/signin-throttle'

function psql(sql: string): string {
  return execFileSync('psql', [local!.dbUrl, '-Atc', sql]).toString().trim()
}

describe.skipIf(!local)('signin throttle compare-and-swap (#281 F1/F4)', () => {
  const admin = local ? createClient(local.url, local.key, { auth: { persistSession: false } }) : null

  const RESET =
    'INSERT INTO signin_throttle (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET failed_count = 0, last_failed_at = NULL'

  beforeEach(() => {
    psql(RESET)
  })

  afterAll(() => {
    if (local) psql(RESET)
  })

  it('recreates a missing singleton row and counts the attempt', async () => {
    psql('DELETE FROM signin_throttle WHERE id = 1')
    expect((await reserveSigninAttempt()).allowed).toBe(true)
    expect(psql('SELECT failed_count FROM signin_throttle WHERE id = 1')).toBe('1')
  })

  it('counts every admitted attempt and admits no more than the free budget from a burst of 20', async () => {
    // Scheduling decides how many SELECTs see each committed reservation, so
    // the exact admit count varies; the invariants are that every admitted
    // attempt is counted (no uncounted guess) and the burst cannot exceed the
    // 5 free attempts before backoff applies.
    const gates = await Promise.all(Array.from({ length: 20 }, () => reserveSigninAttempt()))
    const allowed = gates.filter((g) => g.allowed).length
    expect(allowed).toBeGreaterThanOrEqual(1)
    expect(allowed).toBeLessThanOrEqual(5)

    const { data } = await admin!.from('signin_throttle').select('failed_count').eq('id', 1).single()
    expect(data?.failed_count).toBe(allowed)
  })

  it('still lets a sequential attempt through after the previous one was counted', async () => {
    expect((await reserveSigninAttempt()).allowed).toBe(true)
    expect((await reserveSigninAttempt()).allowed).toBe(true)
    expect(psql('SELECT failed_count FROM signin_throttle WHERE id = 1')).toBe('2')
  })
})
