// The claim loop (#317): claim one queued conversion, run it, record the
// result. Heartbeat and sync nudges live in maintenance.ts on their own timer
// so a long conversion never silences them.
import type { AgentResult, AwcClaim } from '../../lib/awc/conversions-repo'
import { isAwcSignedOut } from '../../lib/awc/stages'
import { createFailureStreak, isTransientNetworkError } from './failure-streak'
import { errorText } from './result'
import type { Ulog } from './ulog'

export interface LoopDeps {
  claimNext: () => Promise<AwcClaim | null>
  runConversion: (claim: AwcClaim) => Promise<AgentResult>
  recordResult: (id: number, result: AgentResult) => Promise<void>
  ulog: Ulog
  statusLine: (line: string) => void
  nowMs: () => number
}

const isDryRun = (r: AgentResult) => r.outcome === 'failed' && r.error.startsWith('dry run')
// The prompt's paywall stop (#320): expected when the owner only follows the
// publication for free, so it is not a bug report.
const isPaywalled = (error: string) => error.startsWith('paywalled')
// A kind added after this daemon was built must never be run as an article.
const isRunnable = (claim: AwcClaim) => claim.kind === 'article' || claim.kind === 'comments'

export function createLoop(deps: LoopDeps) {
  // #366: claim polls fail in short network blips; warn, escalate after 10 min.
  const claimStreak = createFailureStreak({
    ulog: deps.ulog,
    nowMs: deps.nowMs,
    failedMessage: 'awc claim failed',
    recoveredMessage: 'awc claim recovered',
  })
  return {
    async tick(): Promise<'idle' | 'ran' | 'error'> {
      let claim: AwcClaim | null
      try {
        claim = await deps.claimNext()
      } catch (error) {
        const message = errorText(error)
        if (!isTransientNetworkError(message)) {
          // A missing RPC or a permission error won't clear by itself.
          deps.ulog.error('awc claim failed', { error: message })
          deps.statusLine(`poll FAILED: ${message}`)
          return 'error'
        }
        // One "retrying" line, then quiet until escalation: a log watcher reads a
        // last line with FAILED as unhealthy, and a quiet log as stale.
        const { first, escalated } = claimStreak.fail({ error: message })
        if (escalated) deps.statusLine(`poll FAILED: ${message}`)
        else if (first) deps.statusLine(`poll retrying: ${message}`)
        return 'error'
      }
      if (claimStreak.ok()) deps.statusLine('poll recovered')
      if (!claim) return 'idle'
      try {
        deps.statusLine(`conversion ${claim.id} started (item ${claim.contentItemId}, attempt ${claim.attempts})`)
        const result = isRunnable(claim)
          ? await deps.runConversion(claim)
          : ({ outcome: 'failed', path: null, error: 'unsupported conversion kind' } as const)
        try {
          await deps.recordResult(claim.id, result)
        } catch (error) {
          deps.ulog.error('awc result write failed', { conversionId: claim.id, error: errorText(error) })
          deps.statusLine(`conversion ${claim.id} FAILED: could not record result`)
          return 'error'
        }
        if (result.outcome === 'generating' && result.warning) {
          // #363: the card shows "Short episode", so warn rather than open an issue.
          deps.ulog.warn('awc short episode', { conversionId: claim.id, contentItemId: claim.contentItemId, warning: result.warning, path: result.path })
        } else if (result.outcome === 'failed' && isPaywalled(result.error)) {
          deps.ulog.warn('awc conversion paywalled', { conversionId: claim.id, contentItemId: claim.contentItemId, error: result.error })
        } else if (result.outcome === 'failed' && result.error === 'too few comments yet') {
          // #368: normal on a new post. The card says so and Retry re-reads them.
          deps.ulog.warn('awc comments too few', { conversionId: claim.id, contentItemId: claim.contentItemId })
        } else if (result.outcome === 'failed' && isAwcSignedOut(result.error)) {
          // #339: the card says "AWC signed out" and the owner signs in by hand; a
          // alert per sign-out would be noise.
          deps.ulog.warn('awc signed out', { conversionId: claim.id, contentItemId: claim.contentItemId })
        } else if (result.outcome === 'failed' && !isDryRun(result)) {
          // result.error is already bounded (result.ts boundError): one short
          // line — it ends up in an alert.
          deps.ulog.error('awc conversion failed', { conversionId: claim.id, contentItemId: claim.contentItemId, error: result.error, path: result.path })
        }
        deps.statusLine(`conversion ${claim.id} ${result.outcome}${result.outcome === 'failed' ? `: ${result.error}` : ''}`)
        return 'ran'
      } catch (error) {
        // A throw while running a claimed conversion is a bug, not a blip.
        const message = errorText(error)
        deps.ulog.error('awc conversion crashed', { conversionId: claim.id, error: message })
        deps.statusLine(`conversion ${claim.id} FAILED: ${message}`)
        return 'error'
      }
    },
  }
}
