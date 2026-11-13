// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { AGENT_TOOLS, buildAgentArgs, buildChildEnv, buildClaudeArgs } from './claude-args'

describe('buildClaudeArgs', () => {
  const schema = { type: 'object' }
  const args = buildClaudeArgs({ model: 'opus', schema, systemPrompt: 'sys' })
  const after = (flag: string) => args[args.indexOf(flag) + 1]

  it('locks the session down to no tools', () => {
    for (const flag of ['--print', '--restricted', '--strict-mcp-config', '--no-session-persistence']) expect(args).toContain(flag)
    expect(after('--tools')).toBe('')
    expect(args).not.toContain('--chrome')
    expect(args).not.toContain('--allowedTools')
  })

  it('passes model, schema and output format', () => {
    expect(after('--model')).toBe('opus')
    expect(after('--output-format')).toBe('stream-json')
    expect(after('--json-schema')).toBe(JSON.stringify(schema))
    expect(after('--append-system-prompt')).toBe('sys')
  })
})

describe('buildChildEnv', () => {
  it('passes only what the CLI needs', () => {
    const env = buildChildEnv({ HOME: '/h', PATH: '/p', TMPDIR: '/t', USER: 'u', SUPABASE_SERVICE_ROLE_KEY: 'secret' })
    expect(env).toEqual({ HOME: '/h', PATH: '/p', TMPDIR: '/t', USER: 'u' })
  })
})

describe('buildAgentArgs', () => {
  const args = buildAgentArgs({ model: 'opus', systemPrompt: 'sys' })
  const after = (flag: string) => args[args.indexOf(flag) + 1]

  it('gives file and web tools but no shell', () => {
    expect(AGENT_TOOLS).toEqual(['Read', 'Grep', 'Glob', 'Write', 'Edit', 'WebSearch', 'WebFetch'])
    expect(after('--tools')).toBe(AGENT_TOOLS.join(','))
    expect(after('--tools')).not.toMatch(/Bash/)
    expect(after('--allowedTools')).toBe('WebSearch,WebFetch')
    expect(after('--permission-mode')).toBe('acceptEdits')
  })

  it('keeps the rest of the lockdown', () => {
    for (const flag of ['--print', '--restricted', '--strict-mcp-config', '--no-session-persistence']) expect(args).toContain(flag)
    expect(after('--model')).toBe('opus')
    expect(after('--output-format')).toBe('stream-json')
    expect(args).not.toContain('--json-schema')
  })
})

