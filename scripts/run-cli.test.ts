import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'

const REPO_ROOT = path.resolve(__dirname, '..')

function runCli(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('./run', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { stdout, status: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number }
    return { stdout: (e.stdout ?? '') + (e.stderr ?? ''), status: e.status ?? 1 }
  }
}

// Worktree lifecycle is handled by worktrunk (`wt`) via .config/wt.toml, not by
// in-repo shell scripts (#257). These guard against the dead scripts and their
// `./run` entry points coming back.
describe('./run CLI', () => {
  const removedScripts = [
    'scripts/worktree-create.sh',
    'scripts/worktree-switch.sh',
    'scripts/worktree-cleanup.sh',
    'scripts/_worktree-utils.sh',
  ]

  it.each(removedScripts)('does not ship %s', (script) => {
    expect(existsSync(path.join(REPO_ROOT, script))).toBe(false)
  })

  it('does not advertise worktree commands in help output', () => {
    const { stdout, status } = runCli(['--help'])
    expect(status).toBe(0)
    expect(stdout).not.toMatch(/worktree-(create|switch|cleanup)/)
  })

  it('still advertises the initialize command under a Setup heading', () => {
    const { stdout } = runCli(['--help'])
    expect(stdout).not.toContain('Worktree Management:')
    expect(stdout).toMatch(/^Setup:$/m)
    expect(stdout).toContain('initialize')
    expect(stdout).toContain('Set up project after cloning')
  })

  it.each(['worktree-create', 'worktree-switch', 'worktree-cleanup'])(
    'rejects the removed %s command',
    (cmd) => {
      const { stdout, status } = runCli([cmd])
      expect(status).toBe(123)
      expect(stdout).toContain(`ERROR: run-${cmd} not found.`)
    },
  )
})
