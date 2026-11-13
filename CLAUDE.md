# Reading and Listening Tracker - Project Context

## Project Overview

Reading and listening tracking app with Supabase PostgreSQL backend. Built with Next.js 16, React 19, and deployed on Vercel.

## Quick Facts

- **Package Manager**: pnpm@10.20.0
- **Database**: Supabase (PostgreSQL) - https://<project-ref>.supabase.co

## Tech Stack

- Next.js 16 / React 19 / TypeScript
- Supabase (PostgreSQL database + REST API)
- Tailwind CSS 4 + Radix UI
- Vitest + Testing Library (for tests)
- ESLint 10 (flat config)

## Architecture

- **API Routes**: `/api/queue` (GET for fetching, POST for updates)
- **Data Layer**: `lib/queue-client.ts` (client-side data fetching with caching)
- **Database Client**: `lib/supabase.ts` (server-side Supabase client)
- **Type Conversion**: Automatic snake_case ↔ camelCase conversion at API boundary
- Error reporting (#269): server errors go to an external log service via `logError` in `lib/logger/index.ts` (Vercel prod only; `lib/logger/logger.ts` is a vendored client, configured with `LOGGER_URL` / `LOGGER_TOKEN`). Wired: 4 cron routes, /api/sync, /api/add-entry. The Spotify client retries 5xx and network errors twice (`spotifyFetch`, #342); a Spotify 5xx that still fails goes to `logWarn` (only error/alert rows raise an alert), while the run is still marked errored in `sync_logs`. The one non-`index.ts` importer is the Mac daemon's `awc-agent/src/ulog.ts` (`app: reading-list`, `source: awc-agent`, fixed messages, 60 s dedupe) — `index.ts` no-ops off Vercel.

## Available Commands

```bash
./run initialize       # First-time project setup (includes Vercel env pull)
./run dev             # Start development server
./run build           # Build for production
./run lint            # Run ESLint
./run test            # Run Vitest tests (integration tests also run when the local Supabase stack is up)
pnpm run test:watch   # Vitest in watch mode (there is no ./run wrapper for it)
```

## Project-Specific Notes

- Supabase credentials auto-configured by Vercel (see .env.example)
- `USE_MOCK_DATA=true` makes the four list API routes return built-in sample rows; the server still needs Supabase and auth env vars to start
- Uses worktree workflow for feature development, managed by worktrunk (`wt`) — hooks live in `.config/wt.toml`; there are no in-repo worktree scripts
- All supabase commands are run with `supabase ...` and NOT `npx supabase ...` or any other supabase install methods.
- **Database migrations**: Always create migration files in `supabase/migrations/` instead of using the Supabase MCP `apply_migration` tool. The user will deploy migrations manually.
- **Grant Data API access on new tables — to `service_role` ONLY.** Supabase no longer auto-exposes new `public`-schema tables to the Data API — the auto-grant removal hits anon/authenticated **and `service_role`** (enforced on existing projects Oct 30, 2026). This app reaches Supabase only via the Data API (`supabase-js`/PostgREST) with the service_role key, so every migration that `CREATE`s a table must include explicit grants:
  ```sql
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.<table> TO service_role;
  GRANT USAGE, SELECT ON SEQUENCE public.<table>_id_seq TO service_role;  -- if it has a serial PK
  ```
  Do NOT grant to `anon` or `authenticated`, and do NOT write RLS policies without a `TO service_role` clause — the anon key was deliberately locked out of the whole schema (#205, migration `20260710000000`; `supabase/rls-scope.integration.test.ts` enforces this against the local DB). New RPCs get `GRANT EXECUTE ON FUNCTION ... TO service_role;` only — and note that same migration also revoked the Postgres default `PUBLIC` EXECUTE from future functions.

## Database Schema

Two tables hold the content (the original single `queue_items` table was split in migration `20251123000000`):

`content_items`, one row per thing to read or hear:
- Identity: id, kind (`feed` or `book`), title, author, subtitle, series, isbn13, image_url
- Dates: published_on, created_at, updated_at, status_changed_at
- State: status, progress (text such as `45% complete`), added_by
- Ordering: queue_position, position_confirmed (books; legacy for the feed), pinned_at, shortlist_dismissed_at (feed home)
- Size: word_count, duration_seconds
- Summary: summary, summary_data (JSONB), summary_generated_at

`content_sources`, one row per place an item can be opened (joined by `content_item_id`):
- platform, link, is_primary, external_id, source_label, progress (0-100), message_id

Other tables: `curation_runs`, `rss_feeds`, `sync_logs`, `app_settings`, `awc_conversions`, `signin_throttle`, `feedback` (history only).

### Database Constraints

The schema enforces data integrity with CHECK constraints:
- Valid status values: '', 'In Progress', 'Awaiting comments', 'Completed', 'Skip'
- Spotify completion keeps active LessWrong feeds in 'Awaiting comments' until manual completion; automatic progress writes use guarded database RPCs.
- `apply_spotify_progress` skips entries with `source: 'spotify'` when the item has an article `Askwho Casts` source or an active article `awc_conversions` row (#364, #368), so finishing on Spotify no longer auto-completes those items. Apple Podcasts sends no `source`, so it still does.
- position_confirmed = TRUE requires queue_position IS NOT NULL
- Items with status 'Completed' or 'Skip' must have queue_position = NULL
- Auto-update trigger maintains updated_at timestamp on row changes
- Content dedup is DB-enforced (#207): unique index `content_items_title_author_kind_uniq` on `(LOWER(TRIM(title)), LOWER(TRIM(author)), kind)`; `upsert_content_item` creates race-safely via ON CONFLICT — never INSERT into `content_items` directly
- Multi-row `content_items` writers serialize behind one advisory lock (ops issue #337): `apply_spotify_progress`, `place_item_in_queue`, `batch_update_content_items`, `remove_content_items` (#305: bulk delete + close queue gaps) and the legacy `sync_progress` all run `PERFORM pg_advisory_xact_lock(hashtext('content_items:multirow'))` as their FIRST statement (migration `20260919000000`). Any new writer that can touch more than one `content_items` row in one statement or transaction (an `.in('id', ids).update(...)` backfill, a range shift) must take the same lock first, or concurrent syncs deadlock again (`40P01`). Single-row `.eq('id', …)` writes need nothing.
- Comments episodes (#368): `awc_conversions.kind` is `article` or `comments`, still one active row per item. `claim_awc_conversion(p_kinds)` defaults to article only, so a daemon that predates a kind can't claim it. The finished episode is a second `Askwho Casts` source with `source_label = 'Comments'` (`isAwcCommentsSource`, `lib/media-type.ts`), matched like any Script-tab episode. Article-audio checks must ignore it: `hasAwcAudio`, `hasMediaType('audio')`, `heroStartSource`, `apply_spotify_progress`. `markDoneForItem` and `ensureRssSource` are scoped by kind or label, or an article sync would close or overwrite it. In Apple Podcasts it updates only its own row, plus `completeAwaitingComments` when finished. Script builder: `awc-agent/src/comments-script.ts`; see `awc-agent/README.md`.
- `awc_conversions` (#317): "Convert with Askwho Casts" requests. One active (not done/failed) row per item (partial unique index); the Mac daemon claims via `claim_awc_conversion()` (`SKIP LOCKED`; also requeues rows silent 20 min / fails after 2 attempts, fails `generating` rows after 24 h). Stages `queued → starting → submitting_url → building_script → generating → done | failed`. Link-less (Script-tab) feed episodes match ONLY a `generating` + `path='script'` row by normalized `episode_title` — never the general title fallback. All access through `lib/awc/conversions-repo.ts`. Eligibility lives in `lib/awc/eligibility.ts` (#364), shared by the menu and the route: any feed item with an article link, whatever other audio it has, except posts that already have Askwho audio; the article URL is submitted, never `item.link`, which can be Spotify. A `generating`/`done` row whose `error` starts `short episode:` is a daemon warning, not a failure (#363): credits under 65% of `max(reported_words, word_count) / 150`; the card keeps a "Short episode" pill (`isShortEpisode` in `lib/awc/stages.ts`).

### Home = Claude's picks (#377)

The feed no longer reads `queue_position` / `position_confirmed` (books still do). Home shows `buildShortlist` (`lib/shortlist.ts`, shared by SSR and the client): pins (`pinned_at`, newest first), then the latest `succeeded` `curation_runs` picks minus inactive / pinned / dismissed ids, then `recommendedSort(..., { intent: false })`, first 8, top one the hero. `GET /api/queue` returns `{ items, curation }` (`fetchFeedHome`); `/api/books` stays an array. `/everything` is the whole pile (search, filters, Newest / Oldest, PICK pill on what home shows).
- Make next = pin (`pinned_at = now()`, clears `shortlist_dismissed_at`); hand-adds via `/api/add-entry` (saved as `added_by = 'Ben'`, #381; the curator reads `Ben` / `Restored` as the owner's picks) and feed restores are pinned too. Not now = dismiss (`pinned_at = null`, `shortlist_dismissed_at = now()`), off home for `DISMISS_HOLD_DAYS` (21, also imported by `queue-curator`). All single-row, guarded to active feed rows (`lib/content/shortlist-writes.ts`), no advisory lock.
- Feed restore is one update (status `''`, `added_by = 'Restored'`, pinned), not `place_item_in_queue`. Ingest still writes legacy suggested positions; nothing on the feed reads them.

### Schema Gotchas
- `content_items` does NOT have `platform` or `link` columns — those live on `content_sources` (joined via `content_item_id`)
- `insert_or_update_content` RPC rejects empty strings for `p_author` and `p_link` — validate inputs before calling
- Deleting a `content_items` row requires deleting matching `content_sources` rows first (FK dependency)

## Scheduled Jobs (Crons)

Vercel cron feature requires Pro plan, so time-sensitive crons run on a Cloudflare Worker. The per-item Feedback box and its Claude agent (`/api/feedback`, `lib/feedback-agent/`, #86) were removed in #380; the `feedback` table stays as history. The app no longer inserts into it, but `remove_content_items` still deletes an item's feedback rows (FK), so keep it in any content_items delete/merge path until the table is dropped.

**Cloudflare Worker** (`cron-worker/`) — fires within ~1 min of the boundary:
- `*/15 * * * *` → `/api/cron/rss-sync`
- `5-59/15 * * * *` → `/api/cron/askwhocasts-sync` (dual-phase: private feed needs `ASKWHOCASTS_FEED_URL` env and is skipped without it; public "AI Article Readings" Spotify show phase always runs, attaching episodes as `'Spotify'` sources — #237)
- `15 * * * *` → `/api/cron/spotify-sync` (back-catalog guard #305: unplayed episodes released >14d before being saved are not imported when ≥5 arrive from one show; skips land in `sync_logs.metadata.back_catalog_skipped`)
  - Unsaved queue episodes (#329, bearer/cron runs only): Spotify removes fully played episodes from Your Episodes, so `/me/episodes` can miss a finish. `lib/spotify/unsaved-episodes.ts` batch-fetches (`GET /episodes?ids=`) the resume points of active, non-restored queue items' Spotify episodes missing from the saved list; they only update existing items (never create, never counted by the back-catalog guard). Lookup failures are best-effort (`logError` blindSpot `unsaved-queue-episodes`)
  - Show-gap scan (#310, bearer/cron runs only): Spotify auto-download misses some new episodes, so `lib/spotify/show-gaps.ts` checks followed shows (`/me/shows`) for episodes released in the last 7 days (and after the follow date) that are neither saved nor already in `content_sources`, saves them via `PUT /me/library` (needs the `user-library-modify` scope), and imports them in the same run. Findings/errors land in `sync_logs.metadata.show_gap`; a `save_status: 403` means the token predates the scope — re-auth per `docs/spotify-reauth-runbook.md`
- `0 8 * * *` → `/api/cron/substack-import` (daily; imports public Substack subscriptions into `rss_feeds`, requires `SUBSTACK_HANDLE` env)

Worker name: `reading-list-cron`. Operate it from `cron-worker/` (`pnpm run deploy`, `pnpm run tail`). Secret `CRON_SECRET` (set via `wrangler secret put`) must equal `SYNC_API_SECRET` on Vercel. See `cron-worker/README.md`.

**GitHub Actions** hosts `audible-sync.yml` (daily Audible library → `/api/sync`; needs its own Python runtime + credentials, not time-sensitive so GHA cron drift is fine).

**launchd on the Mac** hosts `substack-progress-sync` (hourly at :30 local, Substack read progress → `/api/sync`): Substack's Cloudflare hard-blocks GHA/datacenter IPs with 403 (headers and TLS impersonation don't help — #198), so this one must run from a residential IP. Plist + wrapper in `substack-progress-sync/launchd/`; secrets in `~/.config/reading-list/substack-sync.env`; logs in `~/.claude/logs/substack-progress-sync-*.log`. Do NOT move it (back) to GHA or the Cloudflare Worker.

**launchd on the Mac** also hosts `awc-agent` (#317, KeepAlive): polls `awc_conversions` every 5 s and, per conversion, runs a locked-down `claude --print --chrome --restricted --strict-mcp-config --tools ""` session (browser tools only — no shell/file tools, no secrets in its env) that submits the item to Askwho Casts via the web UI (URL check, or a Studio script for paywalls; fails "paywalled" before spending credits when the signed-in browser session can't read the full post). A Studio script is always the complete article, moved with real cmd+c / cmd+v key presses so it never passes through model output (#363); the daemon empties the Mac's clipboard for those runs and restores its text afterwards, so a failed copy can't paste something else into AWC. If AWC itself is signed out, the agent's one allowed sign-in is clicking through Google's account chooser to `reader@example.com` at the first `/library` load (#339). It never types on Google. Otherwise it fails with `not signed in to askwhocasts.com`, and the card shows "AWC signed out". It must run on a Mac with a Chrome profile that is signed in to Askwho Casts and paired with Claude in Chrome. Stages are `AWC_STAGE:` text markers parsed from the stream; while an episode is generating it pokes `/api/cron/askwhocasts-sync` every 2 min. Code, plist, wrapper and Swift runner in `awc-agent/` (see its README); secrets in `~/.config/reading-list/awc-agent.env`; status log `~/.claude/logs/awc-agent.log` (heartbeat every 60 s) is suitable for a log watcher. Claim polls / heartbeats that fail with a network error log `warn` and print one `retrying` line, escalating to ONE `error` + FAILED lines after 10 minutes (#366, `failure-streak.ts`; other errors stay `error` at once); a Unix-socket lock (`~/.local/state/reading-list/awc-agent.sock`, `instance-lock.ts`) keeps it to one instance, and a second copy waits idle rather than exiting. Tests and local runs use `DRY_RUN=1` (never clicks Generate — credits are real money); `DRY_RUN=cast` rehearses a comments run through Auto Cast (about 2 credits) and stops on Record.

**launchd on the Mac** also hosts `queue-curator` (hourly at :45 from 05:45 to 21:45; it refuses to run from 10 pm to 5 am in its configured time zone): Claude re-ranks the feed queue and saves up to 25 picks with short reasons as one `curation_runs` row (migration `20261109000000`); home shows the latest `succeeded` run (see Home = Claude's picks). Each run exports the queue and the full finished / skipped history into a scratch folder and starts a `claude --print` session on Opus confined to that folder, with file and web tools and no shell; the session writes `picks.json`, which the job validates. The service-role key never reaches the session, and the job never writes `content_items`: its only writes are `curation_runs` and its notes (`app_settings` key `queue_curator_memory`). It skips the model call when its input is unchanged, and a failed run leaves the previous picks in place. `content_items.pinned_at` / `shortlist_dismissed_at` are the user's overrides (Make next / Not now), cleared by a trigger on Completed / Skip. It runs on the Mac and uses the `claude` CLI's own login, not the app's Anthropic API key. Code, plist and wrapper in `queue-curator/` (see its README); secrets in `~/.config/reading-list/queue-curator.env`; status log `~/.claude/logs/queue-curator.log`. `DRY_RUN=1` prints picks and writes nothing.

**launchd on the Mac** also hosts `apple-podcasts-sync` (#322, every 15 min): reads Askwho Casts play state from the Podcasts app's local Core Data store (`~/Library/Group Containers/243LU875E5.groups.com.apple.podcasts/Documents/MTLibrary.sqlite`, opened READ-ONLY) and POSTs it to `/api/sync` as source `apple_podcasts`. Needs Podcasts on the Mac with *Sync Library* on (the job launches Podcasts hidden if it isn't running). `ZPLAYSTATE` 0 = played (incl. Mark as Played), 1 = in progress, 2 = unplayed (never sent); `ZHASBEENPLAYED` is NULL in the current schema. The route matches ONLY by `externalId` `askwhocasts:<ZGUID>` (`findByExternalId`, no title/link fallback), never auto-adds, and applies Spotify's listening rules via `apply_spotify_progress`. The job sends only episodes whose status/progress changed since the last clean run (state `~/.local/state/reading-list/apple-podcasts-sync.json`) — resending a still-played episode would re-archive an item restored to the queue; the route returns `unmatched` externalIds so not-yet-attached episodes are retried. launchd runs the ad-hoc-signed `~/.claude/ApplePodcastsSync.app` (built by `launchd/build-runner.sh`), NOT bash: TCC blocks a launchd bash from the Podcasts Group Container, so Full Disk Access is granted to that app only (re-grant after a rebuild). Code, plist, wrapper and Swift runner in `apple-podcasts-sync/` (see its README); secrets in `~/.config/reading-list/apple-podcasts-sync.env`; logs `~/.claude/logs/apple-podcasts-sync-*.log`. Do NOT move it off the Mac — the data only exists there.

The `DEPLOY_URL` and `CRON_SECRET` GitHub repo secrets are no longer used and can be removed.

## Manual Testing

### Database Safety Rules
- **Default DB is PRODUCTION** — all Supabase queries hit the live cloud database
- **NEVER** run INSERT/UPDATE/DELETE against production without explicit user confirmation
- **Read-only operations** (SELECT, viewing data) are always safe against production
- To use local DB: `./run db-start` then `./run dev --local-db`
- To get fresh prod data locally: `./run db-pull-prod`

### Testing with Dev Server
- `./run dev` — starts dev server pointing at PRODUCTION Supabase (read-only testing only!)
- `./run dev --local-db` — starts dev server pointing at LOCAL Supabase (safe for writes)
- Mock data mode: `USE_MOCK_DATA=true` in `.env.local` stubs the list API routes only (`/api/queue`, `/api/books`, both archives); it is not fully offline, since the server render of home reads the database

### Safe Manual Test Checklist
1. Queue loads and displays items (visit http://localhost:3000)
2. Items show correct status indicators (In Progress, AI-suggested positions)
3. Archive page loads (visit http://localhost:3000/archive)
4. Dropdown menus open, AI Summary toggle works
5. Summary section shows correct state (Generate button vs existing summary)

### Destructive Tests (local DB only!)
- Drag-and-drop reordering
- Completing/skipping items
- Adding new entries
- Generating AI summaries
- Sync endpoint with test payloads

### Direct Supabase Access (from CLI)

For quick read-only queries or targeted writes (with user confirmation) against prod, use the Supabase REST API:

```bash
source .env.local
PROJECT_REF=$(echo "$POSTGRES_URL" | sed -n 's/.*postgres\.\([^:]*\):.*/\1/p')
SUPABASE_URL="https://${PROJECT_REF}.supabase.co"

# SELECT
curl -s "${SUPABASE_URL}/rest/v1/sync_logs?source=eq.rss&order=started_at.desc&limit=5" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" | jq .

# INSERT (use Prefer: return=representation to see the created row)
curl -s -X POST "${SUPABASE_URL}/rest/v1/<table>" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{...}'

# DELETE
curl -s -X DELETE "${SUPABASE_URL}/rest/v1/<table>?id=in.(1,2,3)" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}"
```

PostgREST filter syntax: `?col=eq.value`, `col=in.(a,b)`, `order=col.desc`, `limit=N`, `select=col1,col2`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
