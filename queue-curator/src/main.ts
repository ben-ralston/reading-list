// Entry point.
//   DRY_RUN=1   read the queue, ask Claude, print the picks; no database write.
//               QUEUE_CURATOR_MODE=simple (default) | agent picks the session.
//   QUEUE_CURATOR_REAL=1  the real, unattended run: agent session, picks and notes
//               saved to the database, skipped when nothing changed.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { buildAgentArgs, buildChildEnv, buildClaudeArgs } from './claude-args'
import { loadConfig, type CuratorConfig } from './config'
import { curate } from './curate'
import { fetchActiveItemRows, fetchHistoryRows } from './fetch'
import { PICKS_SCHEMA } from './picks'
import { runAgentDryRun, runDryRun, type AgentOutcome } from './run'
import { runChild } from './spawn'
import { createStore } from './store'
import { sendAlert } from './ulog'

const SYSTEM_PROMPT =
  'You are an unattended automation (claude --print): never ask questions. You have no tools. ' +
  'Answer with the requested JSON only.'
const AGENT_SYSTEM_PROMPT =
  'You are an unattended automation (claude --print): never ask questions. ' +
  'Work only in the current working folder.'

const PACKAGE_DIR = path.join(__dirname, '..')
const packageFile = (name: string) => readFileSync(path.join(PACKAGE_DIR, name), 'utf8')
const readOrNull = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

// The child gets a minimal env (no Supabase key) and a fresh empty folder as
// its cwd, so it sees no secrets and has nothing to discover.
// The folder holds the whole queue and reading history in plain text, so it
// is removed when the session ends, however it ends.
async function inScratchDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'queue-curator-'))
  try {
    return await work(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
const claude = (config: CuratorConfig, args: string[], prompt: string, cwd: string, timeoutMs: number) =>
  runChild(spawn, config.claudeBin, args, { env: buildChildEnv(process.env), cwd, stdin: prompt, timeoutMs })

function runAgent(config: CuratorConfig, prompt: string, files: Record<string, string>): Promise<AgentOutcome> {
  return inScratchDir(async (dir) => {
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content)
    const args = buildAgentArgs({ model: config.model, systemPrompt: AGENT_SYSTEM_PROMPT })
    const stream = await claude(config, args, prompt, dir, config.agentTimeoutMs)
    return { stream, picksFile: readOrNull(path.join(dir, 'picks.json')), memory: readOrNull(path.join(dir, 'memory.md')) }
  })
}

async function dryRun(config: CuratorConfig): Promise<number> {
  const db = createClient(config.supabaseUrl, config.serviceRoleKey, { auth: { persistSession: false } })
  const common = {
    loadItems: () => fetchActiveItemRows(db),
    loadHistory: () => fetchHistoryRows(db),
    instructions: packageFile('instructions.md'),
    now: new Date(),
    out: (line: string) => console.log(line),
  }
  const result = config.mode === 'agent'
    ? await runAgentDryRun({
        ...common,
        template: packageFile('prompt-agent.md'),
        loadMemory: async () => readOrNull(config.memoryFile) ?? '',
        saveMemory: async (text) => {
          mkdirSync(path.dirname(config.memoryFile), { recursive: true })
          writeFileSync(config.memoryFile, text)
        },
        runAgent: (prompt, files) => runAgent(config, prompt, files),
      })
    : await runDryRun({
        ...common,
        template: packageFile('prompt.md'),
        runClaude: (prompt) => {
          const args = buildClaudeArgs({ model: config.model, schema: PICKS_SCHEMA, systemPrompt: SYSTEM_PROMPT })
          return inScratchDir((dir) => claude(config, args, prompt, dir, config.timeoutMs))
        },
      })
  return result.ok ? 0 : 1
}

// One status line per outcome, timestamped, for ~/.claude/logs/queue-curator.log
// (watched by a log watcher: "ok:" / "skipped:" are healthy, "FAILED" is not).
async function realRun(config: CuratorConfig): Promise<number> {
  const db = createClient(config.supabaseUrl, config.serviceRoleKey, { auth: { persistSession: false } })
  const alerts: Promise<unknown>[] = []
  const outcome = await curate({
    ...createStore(db),
    loadItems: () => fetchActiveItemRows(db, { withShortlistColumns: true }),
    loadHistory: () => fetchHistoryRows(db),
    runAgent: (prompt, files) => runAgent(config, prompt, files),
    template: packageFile('prompt-agent.md'),
    instructions: packageFile('instructions.md'),
    model: config.model,
    now: () => new Date(),
    log: (line) => console.log(`${new Date().toISOString()} ${line}`),
    alert: (message, extra) => { alerts.push(sendAlert(message, extra)) },
  })
  // Let the best-effort error report go out before the process exits.
  await Promise.race([Promise.all(alerts), new Promise((resolve) => setTimeout(resolve, 5000))])
  return outcome === 'failed' ? 1 : 0
}

async function main(): Promise<number> {
  const config = loadConfig(process.env)
  if (config.dryRun) return dryRun(config)
  if (!config.real) {
    console.error('queue-curator: set DRY_RUN=1 to print picks without saving. The real run saves to the database and is started by launchd/run-curator.sh (QUEUE_CURATOR_REAL=1).')
    return 1
  }
  return realRun(config)
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.log(`${new Date().toISOString()} FAILED: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  },
)
