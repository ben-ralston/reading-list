// PreToolUse hook for the awc-agent Claude session (#317 review): blocks an
// off-allowlist `navigate` BEFORE it runs. The daemon passes it via
// `--settings` (honored under --restricted) and puts the per-conversion
// allowlist in the child's AWC_ALLOWED_HOSTS. Exit 2 = deny (stderr is shown
// to the agent). Fails closed. The daemon's stream watcher stays as a backstop.
// Entry point: awc-agent/bin/nav-hook.ts.
import { navigationViolation } from './nav-guard'

export function decideNavigation(stdin: string, allowedEnv: string): { block: false } | { block: true; reason: string } {
  const allowed = new Set(allowedEnv.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean))
  if (allowed.size === 0) return { block: true, reason: 'no navigation allowlist configured' }
  let event: { tool_name?: unknown; tool_input?: unknown }
  try {
    event = JSON.parse(stdin) as typeof event
  } catch {
    return { block: true, reason: 'unreadable hook input' }
  }
  const input = event.tool_input && typeof event.tool_input === 'object' ? (event.tool_input as Record<string, unknown>) : {}
  const host = navigationViolation(String(event.tool_name ?? ''), input, allowed)
  return host ? { block: true, reason: `navigation to ${host} is not allowed for this conversion` } : { block: false }
}

// Exit code for Claude Code: 0 = allow, 2 = deny. Any unexpected error denies.
export async function runHook(stdin: AsyncIterable<Buffer | string>, env: NodeJS.ProcessEnv, stderr: { write(s: string): unknown }): Promise<0 | 2> {
  try {
    let input = ''
    for await (const chunk of stdin) input += chunk.toString()
    const decision = decideNavigation(input, env.AWC_ALLOWED_HOSTS ?? '')
    if (!decision.block) return 0
    stderr.write(`${decision.reason}\n`)
    return 2
  } catch {
    stderr.write('navigation check failed\n')
    return 2
  }
}
