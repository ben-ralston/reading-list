// Fingerprint of everything that should cause a fresh ranking. Hashing the
// model input itself, not a hand-kept field list, means any change the agent
// could see (a finished Askwho conversion, a corrected title, new progress)
// triggers a run. The notes file is left out: the agent rewrites it every
// run, so including it would mean never skipping.
import { createHash } from 'node:crypto'

export function inputHash(parts: {
  files: Record<string, string>
  prompt: string
  model: string
  promptVersion: number
}): string {
  const files = Object.entries(parts.files)
    .filter(([name]) => name !== 'memory.md')
    .sort(([a], [b]) => a.localeCompare(b))
  return createHash('sha256')
    .update(JSON.stringify([parts.promptVersion, parts.model, parts.prompt, files]))
    .digest('hex')
}
