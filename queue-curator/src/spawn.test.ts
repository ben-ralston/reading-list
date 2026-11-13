// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { runChild } from './spawn'

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stdin: EventEmitter & { end: (s: string) => void; written: string }
    kill: (signal?: string) => void; signals: string[]
  }
  child.stdout = new EventEmitter()
  child.stdin = Object.assign(new EventEmitter(), { written: '', end(s: string) { this.written = s } })
  child.signals = []
  child.kill = (signal = 'SIGTERM') => { child.signals.push(signal) }
  return child
}
const opts = { env: { HOME: '/h' }, cwd: '/tmp/x', stdin: 'the prompt', timeoutMs: 1000, killGraceMs: 500 }

afterEach(() => vi.useRealTimers())

describe('runChild', () => {
  it('resolves with stdout on a clean exit and passes stdin, env and cwd', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const done = runChild(spawnFn as never, 'claude', ['--print'], opts)
    child.stdout.emit('data', Buffer.from('hello '))
    child.stdout.emit('data', Buffer.from('world'))
    child.emit('close', 0, null)
    expect(await done).toBe('hello world')
    expect(child.stdin.written).toBe('the prompt')
    expect(spawnFn).toHaveBeenCalledWith('claude', ['--print'], expect.objectContaining({ cwd: '/tmp/x', env: { HOME: '/h' } }))
  })

  it('rejects on a non-zero exit', async () => {
    const child = fakeChild()
    const done = runChild((() => child) as never, 'claude', [], opts)
    child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in' })))
    child.emit('close', 2, null)
    await expect(done).rejects.toThrow('claude exited with code 2 (claude ended: success: Not logged in)')
  })

  it('rejects when the binary cannot start', async () => {
    const child = fakeChild()
    const done = runChild((() => child) as never, 'claude', [], opts)
    child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }))
    await expect(done).rejects.toThrow(/ENOENT/)
  })

  it('terminates, then kills, a child that hangs, and says it timed out', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const done = runChild((() => child) as never, 'claude', [], opts)
    const rejected = expect(done).rejects.toThrow('claude timed out after 1 s')
    await vi.advanceTimersByTimeAsync(1000)
    expect(child.signals).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(500)
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    child.emit('close', null, 'SIGKILL')
    await rejected
  })

  it('reports a bare exit code when the child said nothing useful', async () => {
    const child = fakeChild()
    const done = runChild((() => child) as never, 'claude', [], opts)
    child.emit('close', 1, null)
    await expect(done).rejects.toThrow(/^claude exited with code 1$/)
  })
})
