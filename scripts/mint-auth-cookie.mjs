// Mint an iron-session `_auth` cookie for local CLI verification.
//
// The dev server requires auth (see middleware.ts + lib/auth.ts). Hitting
// /sign-in in a browser is the normal flow; this script exists for
// terminal-based curl checks against the local dev server. It reads
// AUTH_PASSWORD_SECRET from the environment and prints the sealed cookie
// value (no trailing newline) so it can be piped into a curl `Cookie:` header.
//
// Usage:
//   set -a && source .env.local && set +a
//   COOKIE="_auth=$(node scripts/mint-auth-cookie.mjs)"
//   curl -H "Cookie: $COOKIE" http://localhost:3000/books

import { sealData } from 'iron-session'

const pw = process.env.AUTH_PASSWORD_SECRET
if (!pw) {
  console.error('AUTH_PASSWORD_SECRET not set (source .env.local first)')
  process.exit(1)
}
const sealed = await sealData(
  { isAuthenticated: true },
  { password: pw, ttl: 60 * 60 * 24 * 30 },
)
process.stdout.write(sealed)
