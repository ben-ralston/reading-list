# substack-progress-sync (#192)

Hourly sync of Substack read progress into the reading-list app. Substack
persists your per-post read position server-side (synced across its web and
mobile apps); this job reads it from the authenticated reader feed and POSTs it
to the app's `/api/sync` webhook, so Substack cards show a progress bar exactly
like Spotify cards. Posts read to ≥97% are marked **Completed**.

The webhook is **update-only for substack** (`shouldAutoAdd`): the reader feed
is a ranked "For You" feed that includes posts you never queued, so only items
already in the queue (via the RSS pipeline) get progress. An archived-guard in
the route also means a Completed/Skip item is never resurrected by this job.

Runs on a **launchd** hourly job on the Mac (`launchd/`), NOT GitHub Actions:
Substack's Cloudflare hard-blocks GHA runner IPs with 403 regardless of
headers or TLS impersonation (probed with browser headers and curl_cffi
chrome impersonation — see #198), while a residential IP passes. The job
executes from the primary worktree's main checkout, like the other local
Claude launchd jobs.

## Layout

```
substack-progress-sync/
  substack_progress_sync/
    build.py     # pure: reader post dicts → /api/sync payload items (unit-tested)
    client.py    # session-cookie auth + paginated reader-feed fetch
    sync.py      # entry point: fetch → build → chunked POST
  tests/         # pytest (build / sync / client)
```

All matching/guard logic lives in the Next.js app (`/api/sync`); this stays
thin. Items carry a stable `substack:post:<id>` externalId that the route
backfills onto the matched source, so after the first title+author match every
later run is an exact external-id match.

## Local development

```bash
uv sync                        # install deps + this package (editable)
uv run pytest                  # run the unit tests
SUBSTACK_SID=... uv run python -m substack_progress_sync.sync --dry-run
```

`--dry-run` (alias `--print-only`) fetches the real reader feed (needs
`SUBSTACK_SID`) but POSTs nothing — use it to eyeball the payload before the
first real run. Two things to check in the output: `author` should be the
**publication name** (that's what the app stores for RSS-imported Substack
items — it's what makes matching land), and progress percentages should look
like your actual reading.

## One-time auth: extract the session cookie

Substack has no public API or OAuth; auth is your logged-in session cookie.
It's long-lived (months), but re-extract it after logging out or changing your
password — the Status page's "Substack progress" section erroring is the
symptom of an expired cookie.

1. Open https://substack.com in a browser where you're logged in.
2. DevTools → Application (Chrome) / Storage (Firefox) → Cookies →
   `https://substack.com`.
3. Copy the value of the `substack.sid` cookie (starts with `s%3A`). Older
   sessions may name it `connect.sid` instead — same value format, copy
   whichever exists (the client sends the value under both names).
4. Put it in `~/.config/reading-list/substack-sync.env` as `SUBSTACK_SID=...`
   (the raw URL-encoded value). The file is `source`d by the wrapper, so
   single-quote any value containing shell-special characters (`$`, spaces,
   backticks).

Never commit the cookie. `.gitignore` covers common accident paths, but the
value should only ever live in that env file and your shell env.

## launchd configuration

`launchd/run-sync.sh` sources `~/.config/reading-list/substack-sync.env`
(chmod 600), which must define:

| Name | Value |
| --- | --- |
| `SUBSTACK_SID` | the `substack.sid` (or legacy `connect.sid`) cookie value |
| `SYNC_API_SECRET` | same value as on Vercel (also in the app's `.env.local`) |
| `SUBSTACK_WEBHOOK_URL` | `https://<prod-domain>/api/sync` |

Install (one-time):

```bash
mkdir -p ~/.claude/logs  # launchd won't create StandardOutPath parents
cp launchd/com.claude.substack-progress-sync.plist ~/Library/LaunchAgents/
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.claude.substack-progress-sync.plist
```

The job fires hourly at :30 past the hour, local time (launchd runs a missed
interval on wake).
Logs: `~/.claude/logs/substack-progress-sync-{stdout,stderr}.log`. Manual run:
`bash launchd/run-sync.sh --dry-run` (or without the flag for a real sync);
health is visible on `/settings/status` under "Substack progress".

## API notes (undocumented, reverse-engineered 2026-07-01)

- `GET https://substack.com/api/v1/reader/posts?limit=10` →
  `{ posts, publications, inboxItems, more }`; each post has `id`, `slug`,
  `canonical_url`, `title`, `publication_id`, `read_progress`,
  `max_read_progress` (0–1 floats for the authenticated user).
- Pagination: the endpoint ignores `offset`/`page`; the working cursor is
  `after=<oldest inboxItems[].inbox_date of the previous page>`. `inboxItems`
  are per-user state rows (`content_key: "post:<id>"` + progress), not posts.
- We use `max_read_progress` (the furthest-read high-water mark).
- `limit=25` errored during investigation; 10 is known-good. The client stays
  ≤1 request/second and caps at 30 pages per run (long-tail posts resurface on
  later runs — progress is monotonic).
- Paywalled posts you don't subscribe to report ~100% at the paywall; those
  arrive as Completed, which matches "read everything available".
