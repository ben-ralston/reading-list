// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acquireInstanceLock, waitForInstanceLock, type InstanceLock } from './instance-lock'

// Short base dir: a Unix socket path must stay under ~104 bytes on macOS.
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'awc-lock-'))
const held: InstanceLock[] = []
const take = async (p: string) => {
  const r = await acquireInstanceLock(p)
  if (r.ok) held.push(r)
  return r
}

afterEach(async () => {
  while (held.length) await held.pop()!.release()
})

describe('acquireInstanceLock (#366)', () => {
  it('takes a free lock, creating its directory', async () => {
    const p = path.join(tmp(), 'nested', 'awc-agent.sock')
    expect((await take(p)).ok).toBe(true)
    expect(existsSync(p)).toBe(true)
  })

  it('refuses a second instance while the first holds the lock', async () => {
    const p = path.join(tmp(), 'awc-agent.sock')
    expect((await take(p)).ok).toBe(true)
    expect(await take(p)).toEqual({ ok: false })
  })

  it('can be taken again after the holder releases it', async () => {
    const p = path.join(tmp(), 'awc-agent.sock')
    const first = await acquireInstanceLock(p)
    if (!first.ok) throw new Error('expected lock')
    await first.release()
    expect((await take(p)).ok).toBe(true)
  })

  // launchd KeepAlive restarts the daemon after a crash; a socket file left
  // behind by a killed holder must not block it.
  it('takes over a lock left behind by a holder that was killed', async () => {
    const p = path.join(tmp(), 'awc-agent.sock')
    await leaveDeadSocket(p)
    expect((await take(p)).ok).toBe(true)
  })

  // Review (Codex P2): two starters must not both reclaim a dead socket.
  it('lets exactly one of several concurrent starters reclaim a dead socket', async () => {
    const p = path.join(tmp(), 'awc-agent.sock')
    await leaveDeadSocket(p)
    const results = await Promise.all(Array.from({ length: 8 }, () => take(p)))
    expect(results.filter((r) => r.ok)).toHaveLength(1)
  })

  // Review round 2 (Codex P2), forced: A has found the socket dead and is
  // about to unlink it when the old file vanishes and B starts. B must not
  // bind through a path A is about to unlink, or both would run.
  it('serializes a fresh bind with a reclaim in progress', async () => {
    const p = path.join(tmp(), 'awc-agent.sock')
    await leaveDeadSocket(p)
    let resumeA: () => void = () => {}
    let aPaused: () => void = () => {}
    const paused = new Promise<void>((r) => { aPaused = r })
    const a = acquireInstanceLock(p, {
      beforeReclaim: () => new Promise<void>((r) => { resumeA = r; aPaused() }),
    })
    await paused
    unlinkSync(p)
    const resultB = await take(p)
    resumeA()
    const resultA = await a
    if (resultA.ok) held.push(resultA)
    expect(resultB).toEqual({ ok: false })
    expect(resultA.ok).toBe(true)
  })

  // Review: a mistyped AWC_AGENT_LOCK_PATH must never delete a real file.
  it('refuses, and leaves alone, a file at the lock path that is not a socket', async () => {
    const p = path.join(tmp(), 'awc-agent.sock')
    writeFileSync(p, 'precious')
    await expect(acquireInstanceLock(p)).rejects.toThrow(/not a socket/)
    expect(readFileSync(p, 'utf8')).toBe('precious')
  })
})

// Review: exiting under launchd KeepAlive would restart every 10 s, so a
// second instance waits, idle, and takes over when the holder stops.
describe('waitForInstanceLock (#366)', () => {
  it('reports once, then takes the lock when the holder releases it', async () => {
    const p = path.join(tmp(), 'awc-agent.sock')
    const first = await acquireInstanceLock(p)
    if (!first.ok) throw new Error('expected lock')
    const onWaiting = vi.fn()
    let sleeps = 0
    const lock = await waitForInstanceLock(p, {
      onWaiting,
      sleep: async () => { sleeps += 1; if (sleeps === 3) await first.release() },
    })
    held.push(lock)
    expect(onWaiting).toHaveBeenCalledTimes(1)
    expect(sleeps).toBe(3)
  })

  it('does not report when the lock is free', async () => {
    const onWaiting = vi.fn()
    held.push(await waitForInstanceLock(path.join(tmp(), 'awc-agent.sock'), { onWaiting, sleep: async () => {} }))
    expect(onWaiting).not.toHaveBeenCalled()
  })
})

// A holder SIGKILLed after binding leaves its socket file behind.
async function leaveDeadSocket(p: string) {
  const child = spawn(process.execPath, ['-e', `
    require('node:net').createServer().listen(${JSON.stringify(p)}, () => process.stdout.write('ready'))
  `])
  await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()))
  expect(await acquireInstanceLock(p)).toEqual({ ok: false })
  child.kill('SIGKILL')
  await new Promise((resolve) => child.once('exit', resolve))
  expect(existsSync(p)).toBe(true)
}
