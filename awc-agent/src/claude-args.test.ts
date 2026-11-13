// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { buildChildEnv, buildClaudeArgs, ALLOWED_TOOLS, DISALLOWED_TOOLS } from './claude-args'

describe('buildChildEnv', () => {
  it('passes only HOME, PATH, TMPDIR, USER and the navigation allowlist — no secrets', () => {
    const env = buildChildEnv({ HOME: '/h', PATH: '/bin', TMPDIR: '/t/', USER: 'b', SUPABASE_SERVICE_ROLE_KEY: 'secret', SYNC_API_SECRET: 's', LOGGER_TOKEN: 't' }, ['app.askwhocasts.com', 'ex.com'])
    expect(env).toEqual({ HOME: '/h', PATH: '/bin', TMPDIR: '/t/', USER: 'b', AWC_ALLOWED_HOSTS: 'app.askwhocasts.com,ex.com' })
  })
})

describe('tool lists', () => {
  it('allows only claude-in-chrome browser tools, never javascript_tool', () => {
    expect(ALLOWED_TOOLS.every((t) => t.startsWith('mcp__claude-in-chrome__'))).toBe(true)
    expect(ALLOWED_TOOLS).toContain('mcp__claude-in-chrome__form_input')
    expect(ALLOWED_TOOLS.some((t) => t.includes('javascript_tool'))).toBe(false)
    expect(DISALLOWED_TOOLS).toContain('mcp__claude-in-chrome__javascript_tool')
    expect(ALLOWED_TOOLS.filter((t) => DISALLOWED_TOOLS.includes(t))).toEqual([])
  })
})

describe('buildClaudeArgs', () => {
  const args = buildClaudeArgs({ systemPrompt: 'SYS', schema: { type: 'object' }, navHookCommand: '/r/tsx /r/nav-hook.ts' })
  const valueOf = (flag: string) => args[args.indexOf(flag) + 1]

  it('strips every built-in tool, settings file and non-chrome MCP server', () => {
    expect(args).toEqual(expect.arrayContaining(['--print', '--chrome', '--restricted', '--strict-mcp-config']))
    expect(valueOf('--tools')).toBe('')
    expect(valueOf('--permission-mode')).toBe('dontAsk')
  })

  it('wires stream-json output, the result schema and the system prompt', () => {
    expect(valueOf('--output-format')).toBe('stream-json')
    expect(args).toContain('--verbose')
    expect(valueOf('--json-schema')).toBe('{"type":"object"}')
    expect(valueOf('--append-system-prompt')).toBe('SYS')
    expect(valueOf('--allowedTools').split(',')).toEqual(ALLOWED_TOOLS)
  })

  it('registers the PreToolUse navigation hook via --settings', () => {
    expect(JSON.parse(valueOf('--settings'))).toEqual({
      // `|| exit 2`: a hook that fails to start must deny, not allow.
      hooks: { PreToolUse: [{ matcher: 'mcp__claude-in-chrome__navigate', hooks: [{ type: 'command', command: '/r/tsx /r/nav-hook.ts || exit 2' }] }] },
    })
  })
})
