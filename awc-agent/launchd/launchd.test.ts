// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const dir = __dirname
const read = (f: string) => readFileSync(path.join(dir, f), 'utf8')

describe('awc-agent launchd packaging (#317)', () => {
  const plist = read('com.claude.awc-agent.plist')

  it('is a KeepAlive daemon labelled com.claude.awc-agent', () => {
    expect(plist).toContain('<string>com.claude.awc-agent</string>')
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/)
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
    expect(plist).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/)
  })

  it('logs status lines where a log watcher looks (~/.claude/logs/awc-agent.log)', () => {
    expect(plist).toContain('<string>/Users/YOUR_USER/.claude/logs/awc-agent.log</string>')
    expect(plist).toContain('<string>/Users/YOUR_USER/.claude/logs/awc-agent-stderr.log</string>')
  })

  it('runs the signed .app runner and carries no secrets', () => {
    expect(plist).toContain('/Users/YOUR_USER/.claude/AwcAgent.app/Contents/MacOS/AwcAgentRunner')
    expect(plist).not.toMatch(/SERVICE_ROLE|SYNC_API_SECRET|LOGGER_TOKEN/)
  })

  it('wrapper is executable, sources the env file and pins TMPDIR', () => {
    const sh = read('run-agent.sh')
    expect(sh).toContain('$HOME/.config/reading-list/awc-agent.env')
    expect(sh).toContain('DARWIN_USER_TEMP_DIR')
    expect(sh).toContain('exec "$REPO_DIR/node_modules/.bin/tsx" awc-agent/src/daemon.ts')
    expect(statSync(path.join(dir, 'run-agent.sh')).mode & 0o111).not.toBe(0)
    expect(statSync(path.join(dir, 'build-runner.sh')).mode & 0o111).not.toBe(0)
  })

  it('runner forwards SIGTERM to the daemon so bootout stops it', () => {
    const swift = read('AwcAgentRunner.swift')
    expect(swift).toContain('SIGTERM')
    expect(swift).toContain('process.terminate()')
  })
})
