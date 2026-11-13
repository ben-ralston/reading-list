// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { loadConfig } from './config'

const base = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' }

describe('loadConfig', () => {
  it('names the missing variable', () => {
    expect(() => loadConfig({ SUPABASE_URL: 'https://x.supabase.co' })).toThrow(/SUPABASE_SERVICE_ROLE_KEY/)
    expect(() => loadConfig({ SUPABASE_SERVICE_ROLE_KEY: 'k' })).toThrow(/SUPABASE_URL/)
  })

  it('applies defaults', () => {
    expect(loadConfig(base)).toEqual({
      supabaseUrl: 'https://x.supabase.co', serviceRoleKey: 'k', claudeBin: 'claude',
      model: 'opus', dryRun: false, real: false, timeoutMs: 600_000, mode: 'simple', agentTimeoutMs: 1_500_000,
      memoryFile: '.local/state/reading-list/queue-curator-memory.md',
    })
  })

  it('reads overrides and the dry-run switch', () => {
    const config = loadConfig({ ...base, DRY_RUN: '1', QUEUE_CURATOR_MODEL: 'sonnet', QUEUE_CURATOR_CLAUDE_BIN: '/bin/claude' })
    expect(config).toMatchObject({ dryRun: true, model: 'sonnet', claudeBin: '/bin/claude' })
  })

  it('needs an explicit switch for the real run', () => {
    expect(loadConfig({ ...base, QUEUE_CURATOR_REAL: '1' }).real).toBe(true)
    expect(loadConfig({ ...base, QUEUE_CURATOR_REAL: 'yes' }).real).toBe(false)
  })

  it('reads the mode and memory file', () => {
    const config = loadConfig({ ...base, HOME: '/Users/b', QUEUE_CURATOR_MODE: 'agent' })
    expect(config.mode).toBe('agent')
    expect(config.memoryFile).toBe('/Users/b/.local/state/reading-list/queue-curator-memory.md')
    expect(loadConfig({ ...base, QUEUE_CURATOR_MODE: 'other' }).mode).toBe('simple')
    expect(loadConfig({ ...base, QUEUE_CURATOR_MEMORY_FILE: '/tmp/m.md' }).memoryFile).toBe('/tmp/m.md')
  })

  it('prefers SUPABASE_URL over NEXT_PUBLIC_SUPABASE_URL', () => {
    expect(loadConfig({ ...base, NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321' }).supabaseUrl).toBe('https://x.supabase.co')
    expect(loadConfig({ SUPABASE_SERVICE_ROLE_KEY: 'k', NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321/' }).supabaseUrl).toBe('http://localhost:54321')
  })
})
