// Runs the claude CLI as a child and returns its stdout. An unattended job
// must never hang and must say why a run died, so: SIGTERM at the timeout,
// SIGKILL after a grace period, and a distinct error for "timed out",
// "exited with code N" and "could not start".
import type { spawn } from 'node:child_process'
import { resultDetail } from './trace'

export function runChild(
  spawnFn: typeof spawn,
  bin: string,
  args: string[],
  opts: { env: Record<string, string>; cwd: string; stdin: string; timeoutMs: number; killGraceMs?: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnFn(bin, args, { env: opts.env as NodeJS.ProcessEnv, cwd: opts.cwd, stdio: ['pipe', 'pipe', 'inherit'] })
    const chunks: Buffer[] = []
    let timedOut = false
    let settled = false
    let killTimer: NodeJS.Timeout | undefined
    const termTimer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        child.kill('SIGKILL')
        // Even if 'close' never arrives (a grandchild holding stdout), stop waiting.
        finish(new Error(timeoutMessage()))
      }, opts.killGraceMs ?? 10_000)
    }, opts.timeoutMs)
    const timeoutMessage = () => `claude timed out after ${Math.round(opts.timeoutMs / 1000)} s`
    const finish = (error: Error | null) => {
      if (settled) return
      settled = true
      clearTimeout(termTimer)
      if (killTimer) clearTimeout(killTimer)
      if (error) reject(error)
      else resolve(Buffer.concat(chunks).toString('utf8'))
    }

    child.stdout!.on('data', (chunk: Buffer) => chunks.push(chunk))
    // The child may exit before reading stdin (EPIPE).
    child.stdin!.on('error', () => {})
    child.stdin!.end(opts.stdin)
    child.on('error', (error) => finish(error))
    child.on('close', (code, signal) => {
      if (timedOut) finish(new Error(timeoutMessage()))
      else if (code !== 0) {
        // The CLI explains itself (not logged in, rate limited) in its last result event.
        const detail = resultDetail(Buffer.concat(chunks).toString('utf8'))
        finish(new Error(`claude exited with ${code === null ? `signal ${signal}` : `code ${code}`}${detail ? ` (${detail})` : ''}`))
      }
      else finish(null)
    })
  })
}
