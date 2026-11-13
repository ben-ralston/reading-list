// Guard (#304): every ingest-triggered generateSummary call must opt into the
// back-catalog guard (`auto: true`), or a bulk import (e.g. following a podcast
// pulls its whole archive, #305) burns ~$0.28 per item on AI summaries. The
// manual /api/summary/generate route is the one caller that must NOT pass it.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, it, expect } from 'vitest'

const API_DIR = join(process.cwd(), 'app', 'api')
const MANUAL_ROUTE = join('summary', 'generate', 'route.ts')

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return routeFiles(path)
    return name === 'route.ts' ? [path] : []
  })
}

const calls = routeFiles(API_DIR).flatMap((file) =>
  [...readFileSync(file, 'utf8').matchAll(/generateSummary\(([^)]*)\)/g)].map((m) => ({
    file: relative(API_DIR, file),
    args: m[1],
  })),
)

describe('generateSummary callers (#304)', () => {
  it('finds the ingest call sites', () => {
    expect(calls.filter((c) => c.file !== MANUAL_ROUTE).length).toBeGreaterThanOrEqual(4)
  })

  it('every ingest caller passes auto: true', () => {
    const missing = calls.filter((c) => c.file !== MANUAL_ROUTE && !/auto:\s*true/.test(c.args))
    expect(missing).toEqual([])
  })

  // Opus 5.5 summaries take ~20-45s and run in after() inside the same
  // invocation; a function killed at maxDuration skips the catch, so the item
  // silently never gets a summary. Ingest routes must allow the 300s Fluid cap.
  it('ingest routes allow at least 300s for background summaries', () => {
    const ingestFiles = [...new Set(calls.filter((c) => c.file !== MANUAL_ROUTE).map((c) => c.file))]
    const tooShort = ingestFiles.filter((file) => {
      const m = readFileSync(join(API_DIR, file), 'utf8').match(/export const maxDuration\s*=\s*(\d+)/)
      return m !== null && Number(m[1]) < 300
    })
    expect(tooShort).toEqual([])
  })

  it('the manual generate route never passes auto', () => {
    const manual = calls.filter((c) => c.file === MANUAL_ROUTE)
    expect(manual.length).toBe(1)
    expect(manual[0].args).not.toMatch(/auto/)
  })
})
