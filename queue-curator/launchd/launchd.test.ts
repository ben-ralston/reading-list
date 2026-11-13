// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const dir = __dirname
const read = (f: string) => readFileSync(path.join(dir, f), 'utf8')

describe('queue-curator launchd packaging', () => {
  const plist = read('com.claude.queue-curator.plist')
  const sh = read('run-curator.sh')

  it('is an hourly daytime job labelled com.claude.queue-curator that also runs at load', () => {
    expect(plist).toContain('<string>com.claude.queue-curator</string>')
    // 05:45 through 21:45, nothing overnight.
    const hours = [...plist.matchAll(/<dict>\s*<key>Hour<\/key>\s*<integer>(\d+)<\/integer>\s*<key>Minute<\/key>\s*<integer>45<\/integer>\s*<\/dict>/g)].map((m) => Number(m[1]))
    expect(hours).toEqual(Array.from({ length: 17 }, (_, i) => i + 5))
    expect(plist).toMatch(/<key>StartCalendarInterval<\/key>\s*<array>/)
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
    expect(plist).not.toContain('KeepAlive')
  })

  it('logs status lines where a log watcher looks', () => {
    expect(plist).toContain('<string>/Users/YOUR_USER/.claude/logs/queue-curator.log</string>')
    expect(plist).toContain('<string>/Users/YOUR_USER/.claude/logs/queue-curator-stderr.log</string>')
  })

  it('runs the wrapper from the primary checkout and carries no secrets', () => {
    expect(plist).toContain('<string>/Users/YOUR_USER/Programming/reading-list-worktrees/reading-list/queue-curator/launchd/run-curator.sh</string>')
    expect(plist).not.toMatch(/SERVICE_ROLE|LOGGER_TOKEN|SECRET/)
  })

  it('wrapper is valid bash, executable, sources the env file and runs the real mode', () => {
    execFileSync('/bin/bash', ['-n', path.join(dir, 'run-curator.sh')])
    expect(statSync(path.join(dir, 'run-curator.sh')).mode & 0o111).not.toBe(0)
    expect(sh).toContain('$HOME/.config/reading-list/queue-curator.env')
    expect(sh).toContain('DARWIN_USER_TEMP_DIR')
    expect(sh).toContain('exec "$REPO_DIR/node_modules/.bin/tsx" queue-curator/src/main.ts')
    expect(sh).toContain('unset DRY_RUN')
    expect(sh).toContain('export QUEUE_CURATOR_REAL=1')
    // The env file may override the checkout to run from, so it is read first.
    expect(sh.indexOf('source "$ENV_FILE"')).toBeLessThan(sh.indexOf('REPO_DIR="${QUEUE_CURATOR_REPO_DIR:-'))
    expect(sh).not.toMatch(/DRY_RUN=/)
  })

  it('reports a missing env file as a FAILED status line', () => {
    expect(sh).toMatch(/FAILED to start: missing/)
  })
})
