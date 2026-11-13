# reading-list cron worker

Cloudflare Worker that fires the Vercel app's `/api/cron/*` endpoints on schedule.

Replaces `.github/workflows/{rss-sync,spotify-sync}.yml`. GitHub Actions free-tier scheduling drifts from `*/15` to ~60–80 min in practice; Cloudflare Worker cron triggers fire within ~1 min of the boundary.

## Schedules

| Cron          | Endpoint                  | Cadence              |
| ------------- | ------------------------- | -------------------- |
| `*/15 * * * *` | `/api/cron/rss-sync`     | every 15 minutes     |
| `15 * * * *`   | `/api/cron/spotify-sync` | every hour at :15    |

Add or change a schedule by editing the `[triggers]` block in `wrangler.toml` and the `ENDPOINTS` map in `src/dispatch.ts`, then `pnpm run deploy`.

## First-time setup

```bash
# 1. Sign up at https://dash.cloudflare.com/sign-up (free)
# 2. From this directory:
pnpm install
pnpm exec wrangler login          # opens browser for OAuth
pnpm run deploy:dry               # creates the Worker without activating triggers
pnpm exec wrangler secret put CRON_SECRET
# Paste the value of SYNC_API_SECRET from the Vercel project (same secret).
pnpm run deploy                   # activates cron triggers (now that the secret exists)
```

Order matters: deploying before setting the secret means the next scheduled fire authenticates with `Bearer undefined` and fails. The dry-run + secret-set + real-deploy sequence avoids that.

## Operations

```bash
pnpm run deploy:dry   # validate config without deploying
pnpm run deploy       # ship a new version
pnpm run tail         # live log tail (shows scheduled fires + errors)
pnpm run typecheck    # tsc --noEmit
```

## Verifying it's working

```bash
# Production sync_logs (read-only against prod):
source ../.env.local
PROJECT_REF=$(echo "$POSTGRES_URL" | sed -n 's/.*postgres\.\([^:]*\):.*/\1/p')
SUPABASE_URL="https://${PROJECT_REF}.supabase.co"

curl -s "${SUPABASE_URL}/rest/v1/sync_logs?source=eq.rss&order=started_at.desc&limit=10" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" | jq '.[].started_at'
```

Expect consecutive `rss` entries ≤16 minutes apart. Pre-Cloudflare baseline was 60–80 min.
