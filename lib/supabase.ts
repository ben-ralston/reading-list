import { createClient } from '@supabase/supabase-js'

// Get Supabase service role key from environment
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    'Missing SUPABASE_SERVICE_ROLE_KEY environment variable. ' +
    'Run `./run initialize` to set up your environment.'
  )
}

// Determine Supabase URL - use explicit env var if set, otherwise extract from POSTGRES_URL
let SUPABASE_URL = process.env.SUPABASE_URL

if (!SUPABASE_URL) {
  // Extract Supabase URL from the Postgres connection URL
  // Format: postgres://postgres.PROJECT_REF:password@aws-1-us-east-1.pooler.supabase.com:6543/postgres
  // Supabase URL: https://PROJECT_REF.supabase.co
  const POSTGRES_URL = process.env.POSTGRES_URL

  if (!POSTGRES_URL) {
    throw new Error(
      'Missing SUPABASE_URL or POSTGRES_URL environment variable. ' +
      'Run `./run initialize` to set up your environment.'
    )
  }

  // Extract project ref from postgres URL
  const projectRefMatch = POSTGRES_URL.match(/postgres\.([^:]+):/)
  if (!projectRefMatch) {
    throw new Error('Unable to extract Supabase project ref from POSTGRES_URL')
  }
  const projectRef = projectRefMatch[1]
  SUPABASE_URL = `https://${projectRef}.supabase.co`
}

// Create a singleton Supabase client for server-side use
// Uses service role key for full database access (bypasses RLS)
export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
})

// Export the URL for use in other modules if needed
export const supabaseUrl = SUPABASE_URL
