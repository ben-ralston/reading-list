// Finds THIS project's local Supabase stack (the one `supabase start` creates
// for the project_id in supabase/config.toml) for the integration tests.
//
// The tests must never assume a database on the default ports is theirs:
// another project's stack can be listening there. Everything comes from
// `supabase status`, which only reports the stack for this project.
import { execFileSync } from 'node:child_process'

export interface LocalStack {
  url: string
  anonKey: string
  serviceRoleKey: string
  dbUrl: string
}

let cached: LocalStack | null | undefined

export function detectLocalStack(): LocalStack | null {
  if (cached !== undefined) return cached
  cached = null
  try {
    const raw = execFileSync('supabase', ['status', '-o', 'json'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20_000,
    }).toString()
    // Output can carry non-JSON noise around the JSON object.
    const status = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1))
    if (status.API_URL && status.ANON_KEY && status.SERVICE_ROLE_KEY && status.DB_URL) {
      announceTarget(status.API_URL, status.DB_URL)
      cached = {
        url: status.API_URL,
        anonKey: status.ANON_KEY,
        serviceRoleKey: status.SERVICE_ROLE_KEY,
        dbUrl: status.DB_URL,
      }
    }
  } catch (error) {
    // A refused target must stop the run, not be mistaken for "no stack".
    if (error instanceof ForbiddenTargetError) throw error
    // No stack for this project (or no CLI): callers skip their suites.
  }
  return cached
}

export class ForbiddenTargetError extends Error {}

const endpoint = (raw: string) => {
  const u = new URL(raw)
  return { host: u.hostname, port: Number(u.port) }
}

// Prints where this test file will connect (host and port only, never
// credentials), so a run's log shows which stack it used. Set
// INTEGRATION_FORBID_PORT_RANGE (for example "54321-54327") to make the run
// fail at once if the resolved stack sits on those ports: useful on a machine
// where another project's stack holds the defaults.
export function announceTarget(apiUrl: string, dbUrl: string): void {
  const api = endpoint(apiUrl)
  const db = endpoint(dbUrl)
  console.log(`[integration] target: db ${db.host}:${db.port}, api ${api.host}:${api.port}`)
  const range = process.env.INTEGRATION_FORBID_PORT_RANGE?.match(/^(\d+)-(\d+)$/)
  if (!range) return
  const [low, high] = [Number(range[1]), Number(range[2])]
  for (const port of [db.port, api.port]) {
    if (port >= low && port <= high) {
      throw new ForbiddenTargetError(`integration tests refused: port ${port} is in the forbidden range ${low}-${high}`)
    }
  }
}

// A URL nothing listens on, so a suite whose stack is down fails its
// availability probe at once instead of reaching some other database.
export const NO_LOCAL_DB = 'postgresql://postgres@127.0.0.1:1/none'

export function localDbUrl(): string {
  return detectLocalStack()?.dbUrl ?? NO_LOCAL_DB
}
