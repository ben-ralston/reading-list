// Keeps the owner's clipboard out of Askwho Casts on the Script path (#363). The agent
// copies the article with real key presses and has no way to check that cmd+c
// worked, so a failed copy would paste whatever he last copied, perhaps a
// password, into a third-party site. Emptying the clipboard first makes a failed
// copy paste nothing, and the agent's paste check then stops the run. Only text
// is restored; an image on the clipboard is lost.
import { execFile, spawn } from 'node:child_process'

export interface ClipboardAccess {
  read: () => Promise<string>
  write: (text: string) => Promise<void>
}

export function createClipboardGuard(clipboard: ClipboardAccess) {
  return async (): Promise<() => Promise<void>> => {
    const saved = await clipboard.read()
    await clipboard.write('')
    return () => clipboard.write(saved)
  }
}

// A comments run (#368). The clipboard is emptied before the agent exists, so a
// paste that comes too early finds nothing, and the script goes on only when the
// agent is about to paste. That leaves seconds, not minutes, in which something
// the owner copies could be pasted instead. Restoring leaves alone anything he copied
// during the run.
export function createScriptClipboard(clipboard: ClipboardAccess, script: string) {
  return async () => {
    const saved = await clipboard.read()
    await clipboard.write('')
    return {
      fill: () => clipboard.write(script),
      release: async () => {
        const current = await clipboard.read()
        if (current === '' || current === script) await clipboard.write(saved)
      },
    }
  }
}

// launchd gives the daemon no locale, and without one pbcopy and pbpaste mangle
// anything that isn't ASCII.
const UTF8_ENV = { ...process.env, LANG: 'en_US.UTF-8' }
// A hung pbcopy must fail the guard (the run then stops), not stall the daemon.
const TIMEOUT_MS = 5_000

export const macClipboard: ClipboardAccess = {
  read: () => new Promise((resolve, reject) => {
    execFile('/usr/bin/pbpaste', { env: UTF8_ENV, maxBuffer: 50_000_000, timeout: TIMEOUT_MS }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  }),
  write: (text) => new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/pbcopy', { env: UTF8_ENV, stdio: ['pipe', 'ignore', 'ignore'], timeout: TIMEOUT_MS })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pbcopy exited ${code}`))))
    child.stdin.on('error', () => {})
    child.stdin.end(text)
  }),
}
