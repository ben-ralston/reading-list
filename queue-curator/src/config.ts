import path from 'node:path'

export interface CuratorConfig {
  supabaseUrl: string
  serviceRoleKey: string
  claudeBin: string
  model: string
  dryRun: boolean
  // The real run writes to the database and uses paid model time, so it needs
  // an explicit switch; only the launchd wrapper sets it.
  real: boolean
  timeoutMs: number
  // 'simple': one tool-less answer. 'agent': a session with file and web tools.
  mode: 'simple' | 'agent'
  agentTimeoutMs: number
  // The agent's notes between runs. A local file for now; no database write.
  memoryFile: string
}

export function loadConfig(env: NodeJS.ProcessEnv): CuratorConfig {
  const supabaseUrl = env.SUPABASE_URL?.trim() || env.NEXT_PUBLIC_SUPABASE_URL?.trim() || ''
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim() || ''
  const missing = [
    ...(supabaseUrl ? [] : ['SUPABASE_URL']),
    ...(serviceRoleKey ? [] : ['SUPABASE_SERVICE_ROLE_KEY']),
  ]
  if (missing.length > 0) throw new Error(`queue-curator missing env: ${missing.join(', ')}`)
  return {
    supabaseUrl: supabaseUrl.replace(/\/+$/, ''),
    serviceRoleKey,
    claudeBin: env.QUEUE_CURATOR_CLAUDE_BIN?.trim() || 'claude',
    model: env.QUEUE_CURATOR_MODEL?.trim() || 'opus',
    dryRun: env.DRY_RUN === '1',
    real: env.QUEUE_CURATOR_REAL === '1',
    timeoutMs: 600_000,
    mode: env.QUEUE_CURATOR_MODE?.trim() === 'agent' ? 'agent' : 'simple',
    agentTimeoutMs: 1_500_000,
    memoryFile:
      env.QUEUE_CURATOR_MEMORY_FILE?.trim() ||
      path.join(env.HOME ?? '', '.local', 'state', 'reading-list', 'queue-curator-memory.md'),
  }
}
