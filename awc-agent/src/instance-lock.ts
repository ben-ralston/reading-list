// Single-instance lock for the awc-agent daemon (#366): two daemons polling
// at once double every log row and race each other for claims. The lock is a
// listening Unix socket, so the kernel tracks liveness: a crashed or killed
// holder leaves only a dead socket file, which the next start detects (connect
// refused) and replaces. No pid files, so no stale lock after a crash, a
// reboot or pid reuse can block launchd's KeepAlive restart.
import { lstat, mkdir, rmdir, stat, unlink } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'

export type InstanceLock = { ok: true; release: () => Promise<void> }
type Acquired = InstanceLock | { ok: false }

// An acquisition takes milliseconds; a mutex dir this old was left by a crash.
const STALE_MUTEX_MS = 30_000

export async function acquireInstanceLock(
  socketPath: string,
  // Test seam: runs after a dead socket is found, before it is unlinked.
  hooks: { beforeReclaim?: () => Promise<void> } = {},
): Promise<Acquired> {
  await mkdir(path.dirname(socketPath), { recursive: true })
  // Every acquisition (fresh bind or reclaim) runs under this mutex: without
  // it, one starter could unlink a socket another has just bound between its
  // liveness check and its unlink, and both would run.
  const mutex = `${socketPath}.acquire`
  if (!(await takeMutex(mutex))) return { ok: false }
  try {
    const first = await listen(socketPath)
    if (first) return first
    await assertSocketOrAbsent(socketPath)
    if (await isHeld(socketPath)) return { ok: false }
    await hooks.beforeReclaim?.()
    if (await assertSocketOrAbsent(socketPath)) await unlink(socketPath)
    return (await listen(socketPath)) ?? { ok: false }
  } finally {
    await rmdir(mutex).catch(() => {})
  }
}

// launchd KeepAlive restarts a process that exits, so a second instance waits
// (idle, no polling of the queue) and takes over once the holder stops.
export async function waitForInstanceLock(
  socketPath: string,
  deps: { onWaiting: () => void; sleep: () => Promise<void> },
): Promise<InstanceLock> {
  let reported = false
  for (;;) {
    const lock = await acquireInstanceLock(socketPath)
    if (lock.ok) return lock
    if (!reported) {
      reported = true
      deps.onWaiting()
    }
    await deps.sleep()
  }
}

// Resolves to the lock, or null when the path is in use.
async function listen(socketPath: string): Promise<InstanceLock | null> {
  const server = net.createServer((socket) => socket.destroy())
  const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
    server.once('error', resolve)
    server.listen(socketPath, () => resolve(null))
  })
  if (error) {
    if (error.code === 'EADDRINUSE') return null
    throw error
  }
  // Never keep the process alive on its own account.
  server.unref()
  return { ok: true, release: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

// true: a live holder answered. false: nothing is listening (dead socket or
// no file). Any other connect error is not proof of death, so it throws.
function isHeld(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(false)
      else reject(error)
    })
  })
}

// Never unlink (or probe) something that isn't a socket: a mistyped
// AWC_AGENT_LOCK_PATH must not delete a real file. Returns whether it exists.
async function assertSocketOrAbsent(socketPath: string): Promise<boolean> {
  const info = await lstat(socketPath).catch(() => null)
  if (info && !info.isSocket()) throw new Error(`awc-agent lock path exists and is not a socket: ${socketPath}`)
  return info !== null
}

async function takeMutex(dir: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(dir)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const info = await stat(dir).catch(() => null)
      if (info && Date.now() - info.mtimeMs < STALE_MUTEX_MS) return false
      await rmdir(dir).catch(() => {})
    }
  }
  return false
}
