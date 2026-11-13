// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { loadConfig } from './config'
const base = { SUPABASE_URL: 'http://localhost:54321', SUPABASE_SERVICE_ROLE_KEY: 'k', SYNC_API_SECRET: 's', DEPLOY_URL: 'https://app.example', AWC_AGENT_REPO_DIR: '/repo', HOME: '/Users/b' }
describe('loadConfig', () => {
  it('reads required vars with defaults', () => {
    const c = loadConfig(base)
    expect(c).toMatchObject({ supabaseUrl: 'http://localhost:54321', dryRun: false, pollMs: 5000, timeoutMs: 25 * 60_000, claudeBin: 'claude', logDir: '/Users/b/.claude/logs' })
  })
  it('DRY_RUN=1 enables dry run', () => expect(loadConfig({ ...base, DRY_RUN: '1' })).toMatchObject({ dryRun: true, dryRunCast: false }))
  it('DRY_RUN=cast is a dry run that also runs Auto Cast (#368)', () => expect(loadConfig({ ...base, DRY_RUN: 'cast' })).toMatchObject({ dryRun: true, dryRunCast: true }))
  it('no DRY_RUN is live', () => expect(loadConfig(base)).toMatchObject({ dryRun: false, dryRunCast: false }))
  // #366: one daemon at a time; a local DRY_RUN daemon can use its own lock.
  it('locks on a socket under ~/.local/state by default', () =>
    expect(loadConfig(base).lockPath).toBe('/Users/b/.local/state/reading-list/awc-agent.sock'))
  it('AWC_AGENT_LOCK_PATH overrides the lock path', () =>
    expect(loadConfig({ ...base, AWC_AGENT_LOCK_PATH: ' /tmp/x.sock ' }).lockPath).toBe('/tmp/x.sock'))
  it('lists every missing variable', () => {
    expect(() => loadConfig({ HOME: '/x' })).toThrow(/SUPABASE_URL.*SUPABASE_SERVICE_ROLE_KEY.*SYNC_API_SECRET.*DEPLOY_URL.*AWC_AGENT_REPO_DIR/)
  })
})
