---
name: verify-changes
description: Verification toolkit for the reading-list app. Use when validating a change before save, before merge, or when the global verify-project skill / /save-work defers to it. A decision matrix maps the shape of the diff to the relevant phases — pick the minimum set that exercises the actual risk surface of the change. Not a fixed sequence.
---

# Reading List Verification Toolkit

This is a **toolkit**, not a script. PRs vary — a CSS tweak doesn't need a psql check; a migration doesn't need a hover-state browser smoke. Pick the phases that match what changed; over-running everything every time is slow and dilutes signal.

The two parts that ARE fixed: always run unit tests + build first (cheap; mocked unless a local Supabase stack is running), and always clean up at the end. Everything between is a menu.

## What changed → recommended phases

| Diff shape | Run |
| --- | --- |
| Pure UI / styling / component refactor | A + E |
| New API route or response-shape change | A + D (and E if the route powers a UI surface) |
| Migration / RPC / schema change | A + B + D |
| Cross-section partitioning (per-kind, per-status, per-user) | A + D, include the contamination-grep check |
| Bulk import / upsert / dedup logic | A + D, include the idempotency check, F if writes need exercising |
| Auth / session changes | A + (D via minted cookie) or (E via the real sign-in flow) |
| Backend-only (sync, cron, scoring) | A + D, F if it writes |
| Tiny / typo / comment-only | A only |

Pick the **minimum** set. If you find yourself running B + D + E + F for a CSS change, you've gone wrong.

## Mode argument

- (default) → use the matrix above to pick phases for the diff
- `full` → also run Phase F (destructive checks, local DB required)
- `quick` → A only
- Explicit list like `A B D` → run only those phases

Track whether you started the dev server so you can clean it up.

---

## Phase A — CLI prereqs (always)

Cheap. If either fails, stop and report — don't proceed.

```bash
./run test    # Vitest. Unit tests mock Supabase; supabase/*.integration.test.ts also run, and write rows, when this project's local stack is up
./run build   # TS + Next.js compile; catches type errors Vitest misses
```

The unit tests use mocked Supabase, so on their own they do NOT catch errors that only show at SSR or against the real schema. That's what Phases B, D, E exist for.

## Phase B — Schema / RPC (psql) — when migrations or RPC changed

Vitest can't verify SQL migrations actually applied, that CHECK constraints fire, that a new RPC has the expected signature, or that the dedup behavior is right. psql is the right tool for these.

```bash
# Local DB must be up — `./run db-start` first, `./run db-reset` to reapply migrations
# Take the URL from this project's own stack; never assume the default port is yours.
PG=$(supabase status -o env | sed -n 's/^DB_URL="\(.*\)"$/\1/p')

# 1. Confirm a new column landed with the right shape
psql "$PG" -P pager=off -X -q -c "\
  SELECT column_name, data_type, is_nullable, column_default \
  FROM information_schema.columns WHERE table_name='<TABLE>' AND column_name='<COL>';"

# 2. Confirm CHECK constraints
psql "$PG" -P pager=off -X -q -c "\
  SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='<CONSTRAINT_NAME>';"

# 3. Confirm an RPC has the expected arg list (catches off-by-one drops/adds)
psql "$PG" -P pager=off -X -q -c "\
  SELECT pg_get_function_arguments(oid) FROM pg_proc WHERE proname='<FN_NAME>';"

# 4. Exercise the RPC directly — confirm new behavior + that constraints reject bad input
psql "$PG" -P pager=off -X -q -c "SELECT <fn>(...);"
```

Useful patterns:
- After re-running a "drop + create or replace function" migration, check the arg list — easy to leave an ambiguous overload behind if the DROP signature didn't match the current shape.
- Exercise constraint rejection paths (`SELECT <fn>('bad value')`) and look for the expected error class.
- For dedup-style RPCs, call twice with the same args and confirm no duplicate rows.

When a migration adds a table or an RLS policy (added by the #196 audit):

```bash
# RLV-010: RLS "USING(true)" with no TO clause applies to PUBLIC — incl. the anon
# publishable key. Combined with the foundational ALTER DEFAULT PRIVILEGES GRANT ALL,
# anon can read/write the whole table via PostgREST, bypassing the iron-session gate.
# A policy row with polroles = {-} (role 0 = PUBLIC) and qual = true is the smell.
psql "$PG" -P pager=off -X -qtA -c "\
  SELECT polname, polroles::regrole[], pg_get_expr(polqual, polrelid) \
  FROM pg_policy WHERE polrelid='public.<table>'::regclass;"

# RLV-023: an upsert whose dedup is a SELECT-then-INSERT on (lower(title),lower(author),
# kind) has NO race protection unless a matching UNIQUE index / ON CONFLICT exists.
# If the only unique index is the pkey, concurrent adds (double-tap, cron overlap) dup.
psql "$PG" -P pager=off -X -qtA -c "\
  SELECT indexname FROM pg_indexes WHERE tablename='content_items' AND indexdef ILIKE '%unique%';"
```

## Phase C — Dev server up (required for D, E, F)

```bash
# Skip start if port already taken — assume the dev server is already running
lsof -i :3000 -t

# Default mode hits prod Supabase (read-only safe). When migrations are in flight
# or you need writes, use --local-db.
./run dev               # prod Supabase, read-only
./run dev --local-db    # local Supabase, safe for writes

# Poll until ready (up to ~15s)
for i in {1..15}; do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/sign-in)
  [ "$code" = "200" ] && break
  sleep 1
done
```

The `default` vs `full` mode boundary in older versions of this skill conflated "destructive" with "needs local DB" — they're not the same. **Use `--local-db` any time you're verifying schema/RPC changes**, even for read-only checks, because production doesn't have your new schema.

## Phase D — CLI smoke (curl + minted cookie + jq + psql)

Fast, scriptable, great for asserting on a dozen routes' responses, on cross-section partitioning, on idempotency, on response shapes — anywhere a browser is overkill or tedious. The dev server is auth-walled (`middleware.ts` + iron-session), so you need a cookie.

### Mint an `_auth` cookie

```bash
set -a && source .env.local && set +a
COOKIE="_auth=$(node scripts/mint-auth-cookie.mjs)"
curl -H "Cookie: $COOKIE" http://localhost:3000/books   # now 200
```

`scripts/mint-auth-cookie.mjs` is a six-line iron-session sealer that produces a valid cookie without going through the sign-in form. Use it for CLI verification; for the actual sign-in UX itself, use Phase E.

### Per-route partitioning check

```bash
# Confirm each kind-scoped route returns only its kind
for path in /api/queue /api/archive /api/books /api/books/archive; do
  echo "=== $path ==="
  curl -s -H "Cookie: $COOKIE" "http://localhost:3000$path" \
    | jq -r '"count: \(length)\nkinds: \([.[].kind] | unique)"'
done
```

### Cross-section contamination grep

Catches the SSR-vs-API filter divergence class of bug (see [bugs this skill was shaped by](#bugs-this-skill-was-shaped-by)). If a server component fetches Supabase directly and forgets a filter that the API route applies, the initial HTML paint will include the wrong items.

```bash
# Confirm /books items don't bleed into the feed page's rendered HTML
curl -s -H "Cookie: $COOKIE" http://localhost:3000/ \
  | grep -oE "Sapiens|Hard Thing|Made to Stick"   # any books-only title

# Confirm the books page doesn't show feed items
curl -s -H "Cookie: $COOKIE" http://localhost:3000/books \
  | grep -oE "Atomic Habits|Lex Fridman"          # any feed-only title
```

Both should be empty. If they're not, an SSR fetch is missing a filter that the API route has.

### Idempotency check (bulk imports, sync routes)

Re-run the same import payload. If `created` doesn't drop to 0 on the second run, the matching/dedup layer is broken.

```bash
# First run
curl -s -H "Cookie: $COOKIE" -F "file=@fixture.csv" \
  http://localhost:3000/api/import/<source> | jq '{created, updated, skipped}'

# Second run — created MUST be 0
curl -s -H "Cookie: $COOKIE" -F "file=@fixture.csv" \
  http://localhost:3000/api/import/<source> | jq '{created, updated, skipped}'
```

### Response-header + auth-shape checks (added by the #196 audit)

Two whole-repo audit findings only surface at the HTTP layer — assert them whenever a
route's caching or auth behavior is in scope:

```bash
# RLV-003: mutable data routes must NOT be edge-cacheable. A shared s-maxage let the
# Vercel CDN serve a pre-mutation queue for 30-90s even with force-dynamic pages.
for path in /api/queue /api/books; do
  printf "%-14s " "$path"
  curl -s -D - -o /dev/null -H "Cookie: $COOKIE" "http://localhost:3000$path" \
    | grep -i '^cache-control'   # expect: no-store (never s-maxage / stale-while-revalidate)
done

# RLV-015: an unauthenticated /api/* call currently 307-redirects to the /sign-in HTML
# page. fetchWithRetry follows it and mutation helpers read the 200 HTML as success —
# expired-session writes are silently dropped. A hardened build should answer 401 JSON.
curl -s -o /dev/null -w "no-cookie /api/queue -> %{http_code}\n" http://localhost:3000/api/queue
```

### Sample drag-reorder / status-update / restore exercise

Use this when verifying that POST actions are correctly scoped (e.g., reordering one section doesn't shift another). Cross-check via psql after each call.

```bash
# Swap two positions via batchUpdate
curl -s -H "Cookie: $COOKIE" -H "Content-Type: application/json" \
  -X POST http://localhost:3000/api/<kind> \
  -d '{"action":"batchUpdate","updates":[{"id":N,"queuePosition":2},{"id":M,"queuePosition":3}]}' | jq

# Confirm the OTHER section didn't move (psql)
psql "$PG" -P pager=off -X -q -c "\
  SELECT id, title, queue_position FROM content_items \
  WHERE kind='<other-kind>' AND queue_position IS NOT NULL ORDER BY queue_position;"

# Status round-trip via CLI (RLV-003 behavioral check): the POST body MUST carry an
# explicit `action` — a bare {id,status} returns 400 "Invalid action". Completing an
# item must drop it from the *active* queue immediately (no-store, not a 30s CDN stale).
curl -s -H "Cookie: $COOKIE" -H "Content-Type: application/json" -X POST \
  http://localhost:3000/api/queue \
  -d '{"action":"updateStatus","id":N,"status":"Completed"}' | jq
curl -s -H "Cookie: $COOKIE" http://localhost:3000/api/queue \
  | jq 'any(.[]; .id==N)'   # expect false immediately; then restore with status:"In Progress"
```

## Phase E — Browser smoke (claude-in-chrome)

Slower, but catches what CLI can't: visual regressions, layout/spacing, hover/focus states, drag-and-drop interaction quality, animations, anything where the UX itself is the contract.

### Auth via the real sign-in form (not the cookie minter)

Use this when the auth flow itself is in scope — otherwise the cookie minter is faster.

1. `mcp__claude-in-chrome__tabs_context_mcp` — get current tabs
2. `mcp__claude-in-chrome__tabs_create_mcp` → `http://localhost:3000`
3. `mcp__claude-in-chrome__read_page` — sign-in form or already-authed?
4. If sign-in: `grep '^AUTH_PASSWORD=' .env.local | cut -d'=' -f2`, then `mcp__claude-in-chrome__form_input` + click "Sign in" via `mcp__claude-in-chrome__computer`

### Common checks (pick the ones the diff actually touches)

- **Queue page**: items render, status indicators show, queue positions visible, AI-suggested items have the dashed border + "AI" badge
- **Archive page**: completed/skipped items listed with statuses
- **Interactive elements**: dropdown menus open (don't click destructive items in non-full mode), AI Summary toggle works
- **Summary section**: existing summaries display with timestamps; empty items show a Generate button
- **Drag-and-drop**: pick this up only via browser — `dnd-kit` interactions don't surface via curl
- **Layout/spacing**: take a screenshot via `mcp__claude-in-chrome__take_screenshot` when verifying visual changes

Don't read the entire page repeatedly — `mcp__claude-in-chrome__find` is cheaper for targeted assertions.

## Phase F — Destructive (full mode, local DB required)

Only in `full` mode. Verifies the actual write paths against the local DB.

Verify the local DB is up before starting:
```bash
psql "$PG" -c "SELECT 1" 2>/dev/null   # $PG from `supabase status`, as in Phase B
```

### Summary generation

Click "Generate Summary" on an item without one, wait for the loader to disappear, read the page to confirm summary text + timestamp appeared. Requires `ANTHROPIC_API_KEY`; if it errors with a key issue, report as "skip (no API key)".

### Status change round-trip

Open a queue item's dropdown, click "Skip" or "Complete", navigate to `/archive` (or `/books/archive` for kind='book'), confirm the item appears. Then restore from the archive and confirm it comes back at the right position.

### Idempotency under real writes

Run the CSV idempotency check from Phase D against the local DB to confirm the matching layer actually dedups, not just that the API reports it.

## Always — cleanup + report

### Cleanup

```bash
# Kill by port, not by saved PID — `./run dev` is a shell wrapper; the underlying
# `next dev` outlives the parent shell once the wrapper exits.
lsof -i :3000 -t | xargs kill 2>/dev/null
# `pkill -f "next dev"` also works.

# Verify
lsof -i :3000 -t   # should return nothing
```

Don't close Chrome tabs — leaving them lets you inspect visual results.

### Summary report

Adapt the shape to which phases ran. Don't report on phases you skipped — that's misleading. Example for an A + B + D run:

```
Reading List Verification: PASSED
  Phase A — CLI prereqs:
    test:           pass (549/549)
    build:          pass
  Phase B — Schema/RPC (psql):
    kind column:    present, CHECK ok, defaults to 'feed'
    RPC signature:  12 args, ends in p_kind
    dedup:          IS NOT DISTINCT FROM works (re-insert leaves source_count unchanged)
  Phase D — CLI smoke:
    /api/queue:     14 items, kinds=["feed"]
    /api/books:     correct, cross-section grep clean
    idempotency:    re-run created=0
    reorder:        feed positions untouched after books swap
```

If any check fails: report which, with the error text, but **don't block the save**.

---

## Bugs this skill was shaped by

Specific historical bugs each phase exists to catch. New findings belong here so the skill evolves with the codebase.

- **SSR vs API filter divergence (#147, 2026-05-28)** — `app/page.tsx` fetched Supabase directly without the `kind='feed'` filter that `/api/queue` had. Home page's initial paint included books that vanished on the next refresh. **Caught by Phase D's contamination-grep check.** Vitest didn't catch it (mocked supabase), prod build didn't catch it (typechecks pass), browser smoke would have caught it if specifically looking.
- **Wrong RPC drop signature (#147, 2026-05-26)** — An early draft of the books-mode migration dropped `insert_or_update_content(9 args)` but the actual prod signature had 11 args (post-`p_external_id`/`p_added_by`). Would have left an ambiguous overload. **Caught by Phase B's `pg_get_function_arguments` check** against the post-migration DB.
- **Nullable-link UI break (#147, 2026-05-26)** — `source.link.startsWith(...)` exploded after `content_sources.link` became nullable. Vitest didn't catch it (test fixtures used non-null links); `pnpm exec next build` did (strict TS). **Phase A.build is the gate** — always run it after a type-nullability change.
- **Globally-scoped `insertAtSmartPosition` (#147, 2026-05-26)** — Was shifting items across kinds. **Phase D's reorder cross-kind check** would catch the same class of bug.

### Seeded by the #196 whole-repo deep audit (2026-07-07, audited SHA `6a590c3`)

- **Edge-cache staleness (RLV-003, fixed on branch)** — `/api/queue` still sent `Cache-Control: s-maxage=30, stale-while-revalidate=60` after the #189 pages went force-dynamic, so the Vercel CDN kept serving a pre-mutation queue for 30-90s. **Caught by Phase D's Cache-Control check** (expect `no-store`) and behaviorally by the Phase D/F status round-trip (completed item must vanish from the active queue immediately).
- **Auth 307-vs-401 silent write loss (RLV-015, drafted)** — Middleware answers an unauthenticated `/api/*` with a 307 to the `/sign-in` HTML page; `fetchWithRetry` follows it, mutation helpers read the 200 HTML as success, and an expired-session write is silently dropped. **Caught by Phase D's auth-shape check** (a no-cookie `/api/*` should be 401 JSON, not 307).
- **Anon-writable tables via RLS USING(true) (RLV-010, drafted)** — Content tables' RLS policies are `USING(true)` with no `TO` clause (apply to PUBLIC incl. the anon key) on top of `GRANT ALL` default privileges, so the publishable key can CRUD the whole DB via PostgREST. **Caught by Phase B's `pg_policy` check.**
- **Dedup race with no DB guard (RLV-023, drafted)** — `upsert_content_item` dedups via SELECT-then-INSERT on `(lower(title),lower(author),kind)` with no unique index / ON CONFLICT, so double-tap adds and cron overlap create duplicate `content_items`. **Caught by Phase B's unique-index check.**
- **Reflected/stored XSS in HTML-emitting endpoints & scripts (RLV-001 spotify callback, RLV-005 rss-backfill preview; both fixed on branch)** — Any route or operator script that interpolates untrusted text into an HTML/`<script>` body must escape it (`escapeHtml` for markup context, `scriptJson` — escapes `<` — for inline-script JSON). Grep new HTML-returning code for un-escaped template interpolation of request/feed data.
- **Non-constant-time secret compares (RLV-016, fixed on branch)** — The cron routes used `authHeader === \`Bearer ${secret}\``; the shared `lib/bearer-auth.ts` `bearerTokenMatches()` is now the one timing-safe bearer check. New bearer-guarded routes must use it, never a raw `===`.
