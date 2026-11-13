import path from 'node:path'

export interface AgentConfig {
  supabaseUrl: string
  serviceRoleKey: string
  syncSecret: string
  deployUrl: string
  repoDir: string
  claudeBin: string
  logDir: string
  // #366: single-instance lock (a Unix socket; see instance-lock.ts).
  lockPath: string
  dryRun: boolean
  // DRY_RUN=cast: a comments run also spends its Auto Cast, then stops on Record.
  dryRunCast: boolean
  pollMs: number
  timeoutMs: number
}

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SYNC_API_SECRET', 'DEPLOY_URL', 'AWC_AGENT_REPO_DIR'] as const

export function loadConfig(env: NodeJS.ProcessEnv): AgentConfig {
  const missing = REQUIRED.filter((k) => !env[k]?.trim())
  if (missing.length > 0) throw new Error(`awc-agent missing env: ${missing.join(', ')}`)
  const home = env.HOME ?? ''
  return {
    supabaseUrl: env.SUPABASE_URL!.trim(),
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
    syncSecret: env.SYNC_API_SECRET!.trim(),
    deployUrl: env.DEPLOY_URL!.trim().replace(/\/+$/, ''),
    repoDir: env.AWC_AGENT_REPO_DIR!.trim(),
    claudeBin: env.AWC_AGENT_CLAUDE_BIN?.trim() || 'claude',
    logDir: env.AWC_AGENT_LOG_DIR?.trim() || path.join(home, '.claude', 'logs'),
    lockPath: env.AWC_AGENT_LOCK_PATH?.trim() || path.join(home, '.local', 'state', 'reading-list', 'awc-agent.sock'),
    dryRun: env.DRY_RUN === '1' || env.DRY_RUN === 'cast',
    dryRunCast: env.DRY_RUN === 'cast',
    pollMs: 5000,
    timeoutMs: 25 * 60_000,
  }
}
