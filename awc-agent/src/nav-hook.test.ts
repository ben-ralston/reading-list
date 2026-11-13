// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { decideNavigation } from './nav-hook'

const NAV = 'mcp__claude-in-chrome__navigate'
const ALLOWED = 'app.askwhocasts.com,askwhocasts.com,ex.com,www.ex.com'
const input = (url: string, tool = NAV) => JSON.stringify({ tool_name: tool, tool_input: { url, tabId: 1 } })

describe('decideNavigation', () => {
  it('allows Askwho Casts and the item host', () => {
    expect(decideNavigation(input('https://app.askwhocasts.com/#script'), ALLOWED)).toEqual({ block: false })
    expect(decideNavigation(input('https://www.ex.com/p'), ALLOWED)).toEqual({ block: false })
  })
  it('blocks any other host before the tool runs', () => {
    expect(decideNavigation(input('https://mail.google.com/'), ALLOWED)).toEqual({ block: true, reason: 'navigation to mail.google.com is not allowed for this conversion' })
  })
  it('fails closed on unreadable input or a missing allowlist', () => {
    expect(decideNavigation('not json', ALLOWED).block).toBe(true)
    expect(decideNavigation(input('https://ex.com/p'), '').block).toBe(true)
  })
  it('ignores other tools', () => {
    expect(decideNavigation(input('https://evil.io', 'mcp__claude-in-chrome__computer'), ALLOWED)).toEqual({ block: false })
  })
})

describe('nav-hook CLI (as Claude Code runs it)', () => {
  const run = (stdin: string) => spawnSync(
    path.join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx'),
    [path.join(__dirname, '..', 'bin', 'nav-hook.ts')],
    { input: stdin, env: { ...process.env, AWC_ALLOWED_HOSTS: ALLOWED }, encoding: 'utf8' },
  )
  it('exits 2 with a reason on stderr for a blocked host', () => {
    const r = run(input('https://attacker.example/?d=x'))
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('attacker.example')
  })
  it('exits 0 for an allowed host', () => {
    expect(run(input('https://ex.com/p')).status).toBe(0)
  })
  it('exits 2 on garbage input', () => {
    expect(run('{').status).toBe(2)
  })
}, 20_000)
