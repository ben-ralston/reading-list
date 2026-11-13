// Runs one Claude-in-Chrome session for a claimed conversion (#317) and
// returns its AgentResult. Always resolves: failures, crashes and timeouts
// come back as outcome 'failed' so the loop can record them.
import type { AgentResult, AwcClaim } from '../../lib/awc/conversions-repo'
import type { AgentStage } from '../../lib/awc/stages'
import { normalizeTitle } from '../../lib/sync/normalize-title'
import { buildChildEnv } from './claude-args'
import { allowedHostsFor, navigationViolation } from './nav-guard'
import { boundError, coverageWarning, parseClaudeResult } from './result'
import { createStageParser } from './stage-markers'

export interface ChildLike {
  stdout: AsyncIterable<Buffer | string>
  // Resolves on exit; `signal` carries 'spawn error: …' when the binary
  // could not be started (Node reports that asynchronously).
  exited: Promise<{ code: number | null; signal: string | null }>
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void
}

export interface Transcript {
  write(chunk: string): void
  close(): Promise<void>
}

export interface RunDeps {
  spawnClaude: (args: string[], env: Record<string, string>, stdin: string, cwd: string) => ChildLike
  ensureChrome: () => Promise<void>
  onStage: (stage: AgentStage) => Promise<void>
  onRejectedStage: (value: string) => void
  onNavigationViolation: (host: string) => void
  onTitleMismatch?: () => void
  // Called when the Script path starts; the returned function restores (#363).
  guardClipboard?: () => Promise<() => Promise<void>>
  // A comments run (#368): `prepare` empties the clipboard before the agent
  // exists, and `fill` places the script at the building_script marker, just
  // before the paste. Article runs copy the article themselves instead.
  script?: {
    episodeTitle: string
    words: number
    prepare: () => Promise<{ fill: () => Promise<void>; release: () => Promise<void> }>
  }
  // Streams the raw session to disk as it arrives (screenshot-heavy; never
  // held in memory).
  openTranscript: (claim: AwcClaim) => Transcript
  args: string[]
  parentEnv: NodeJS.ProcessEnv
  promptText: string
  cwd: string
  timeoutMs: number
  // After SIGTERM, how long before SIGKILL and before giving up on the exit.
  killGraceMs?: number
}

const SCRIPT_CLIPBOARD_ERROR = 'could not use the clipboard — stopped'

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function stop(child: ChildLike, grace: number): Promise<void> {
  child.kill('SIGTERM')
  const exited = await Promise.race([child.exited.then(() => true), delay(grace).then(() => false)])
  if (!exited) {
    child.kill('SIGKILL')
    // Never wait forever on a wedged child: the daemon must keep polling.
    await Promise.race([child.exited, delay(grace)])
  }
}

export async function runConversion(claim: AwcClaim, deps: RunDeps): Promise<AgentResult> {
  const grace = deps.killGraceMs ?? 10_000
  // A comments run has no reason to open the post: only Askwho Casts is allowed.
  const allowedHosts = allowedHostsFor(claim.kind === 'comments' ? '' : claim.sourceUrl)
  const transcript = deps.openTranscript(claim)
  const seen = new Set<AgentStage>()
  let resultLine = ''
  let violation: string | null = null
  let child: ChildLike | null = null
  let clipboardGuard = null as Promise<(() => Promise<void>) | null> | null
  let clipboardFailed = false as boolean
  let scriptClipboard = null as { fill: () => Promise<void>; release: () => Promise<void> } | null
  let scriptFilled = null as Promise<void> | null
  let scriptFailed = false as boolean
  // Stage writes are serialized so they land in order.
  let stageWrites = Promise.resolve()
  const parser = createStageParser({
    onStage: (stage) => {
      seen.add(stage)
      if (stage === 'building_script' && scriptClipboard && !scriptFilled) {
        scriptFilled = scriptClipboard.fill().catch(() => {
          scriptFailed = true
          if (child) void stop(child, grace)
        })
      }
      if (stage === 'building_script' && !clipboardGuard && deps.guardClipboard && !deps.script) {
        // Fail closed: if the clipboard can't be emptied, a failed cmd+c would
        // paste whatever is on it. No credits are spent this early.
        clipboardGuard = deps.guardClipboard().catch(() => {
          clipboardFailed = true
          if (child) void stop(child, grace)
          return null
        })
      }
      stageWrites = stageWrites.then(() => deps.onStage(stage)).catch(() => {})
    },
    onRejected: deps.onRejectedStage,
    onToolUse: (name, input) => {
      const host = navigationViolation(name, input, allowedHosts)
      if (host && !violation) {
        violation = host
        deps.onNavigationViolation(host)
        child?.kill('SIGTERM')
      }
    },
    onResultLine: (line) => { resultLine = line },
  })

  const raw = await (async (): Promise<AgentResult> => {
    try {
      if (deps.script) {
        try {
          scriptClipboard = await deps.script.prepare()
        } catch {
          return { outcome: 'failed', path: 'script', error: SCRIPT_CLIPBOARD_ERROR }
        }
      }
      await deps.ensureChrome()
      const running = deps.spawnClaude(deps.args, buildChildEnv(deps.parentEnv, allowedHosts), deps.promptText, deps.cwd)
      child = running
      const reading = (async () => {
        for await (const chunk of running.stdout) {
          const text = chunk.toString()
          transcript.write(text)
          parser.push(text)
        }
      })().catch(() => {})

      const outcome = await Promise.race([running.exited, delay(deps.timeoutMs).then(() => 'timeout' as const)])
      if (outcome === 'timeout') await stop(running, grace)
      if (clipboardFailed) {
        return { outcome: 'failed', path: 'script', error: 'could not empty the clipboard — stopped' }
      }
      if (scriptFailed) return { outcome: 'failed', path: 'script', error: SCRIPT_CLIPBOARD_ERROR }
      if (outcome === 'timeout') return { outcome: 'failed', path: null, error: 'agent timed out' }
      await Promise.race([reading, delay(1000)])
      parser.flush()
      if (violation) {
        return { outcome: 'failed', path: null, error: boundError(`agent tried to open ${violation} — stopped`) }
      }
      const result = parseClaudeResult(resultLine)
      if (result.outcome === 'failed' && result.error === 'agent produced no result' && outcome.code !== 0) {
        return { outcome: 'failed', path: null, error: boundError(`claude exited ${outcome.code ?? outcome.signal} without a result`) }
      }
      return result
    } catch (error) {
      return { outcome: 'failed', path: null, error: boundError(`agent could not start: ${(error as Error).message}`) }
    }
  })()

  await stageWrites
  // Best-effort: never let the clipboard change the conversion's result.
  await Promise.race([
    Promise.all([
      clipboardGuard?.then((release) => release?.()).catch(() => {}),
      Promise.resolve(scriptFilled).then(() => scriptClipboard?.release()).catch(() => {}),
    ]),
    delay(grace),
  ])
  await transcript.close().catch(() => {})

  // The agent reports `generating` right after clicking Generate: from then
  // on credits are spent and the episode will reach the feed whatever goes
  // wrong afterwards (timeout, max turns, a guard kill). Record it as
  // generating — never as a failure that invites a second paid Retry.
  if (raw.outcome === 'failed' && seen.has('generating')) {
    return {
      outcome: 'generating',
      path: deps.script || seen.has('building_script') ? 'script' : 'url',
      episodeTitle: deps.script?.episodeTitle ?? claim.title,
      credits: null,
    }
  }
  if (raw.outcome === 'generating') {
    // A link-less episode attaches only to a path='script' row with this exact
    // title. The daemon knows both, and the session read strangers' comments, so
    // a comments run doesn't take the model's word for either (#368).
    if (deps.script && normalizeTitle(raw.episodeTitle) !== normalizeTitle(deps.script.episodeTitle)) deps.onTitleMismatch?.()
    const generating = deps.script ? { ...raw, path: 'script' as const, episodeTitle: deps.script.episodeTitle } : raw
    // Flagged, not failed: the credits are spent and the episode reaches the
    // feed either way, and a failure would invite a paid Retry (#363).
    const warning = coverageWarning({ credits: raw.credits, reportedWords: raw.reportedWords ?? null, wordCount: deps.script?.words ?? claim.wordCount })
    return warning ? { ...generating, warning } : generating
  }
  return raw
}
