# apple-podcasts-sync

Every 15 minutes, reports Askwho Casts listen progress from **Apple Podcasts**
to the reading-list `/api/sync` webhook (source `apple_podcasts`, #322), so
finishing an episode in Apple Podcasts completes its queue item — the same
rules as the Spotify sync (≥95%, or ≤2 min left at ≥80%; progress only rises;
Completed/Skip/Awaiting comments respected; LessWrong → Awaiting comments).

## How it works

Apple has no API for podcast play state. The Podcasts app on this Mac keeps a
Core Data store at

```
~/Library/Group Containers/243LU875E5.groups.com.apple.podcasts/Documents/MTLibrary.sqlite
```

which mirrors the iPhone library when **Podcasts → Settings → General → Sync
Library** is on. The job:

1. launches Podcasts hidden (`open -gj -a Podcasts`) if it isn't running, so
   the library keeps syncing;
2. opens the database **read-only** (`mode=ro`) and selects played
   (`ZPLAYSTATE=0`, incl. "Mark as Played") and in-progress (`1`) episodes of
   the private Askwho Casts feed (`askwhocasts.com` / `app.askwhocasts.com`);
3. maps each to `{externalId: "askwhocasts:<ZGUID>", progress, status}` and
   POSTs only the ones whose status/progress changed since the last clean
   delivery (state in `~/.local/state/reading-list/apple-podcasts-sync.json`).
   Resending a still-played episode every run would re-archive an item you
   restored to the queue. IDs the server couldn't match yet are retried; a run
   with item errors saves no state, so everything is retried.

Failures (DB unreadable, missing env, HTTP error, item writes failed) exit
non-zero with a `[apple-podcasts-sync] FAILED:` line on stderr. If `LOGGER_CLIENT_DIR`
is set to a directory holding a `logger.py` client, the failure is also sent
to that log service (app `reading-list`, source `apple-podcasts-sync`).

The server matches **only** by that external ID (the askwhocasts-sync cron
stores it on the item's source row) and never creates items. Unplayed episodes
are never sent.

## Setup

```bash
cd apple-podcasts-sync
uv sync
uv run pytest
uv run python -m apple_podcasts_sync.sync --dry-run   # prints the changed items; no POST, no state, no app launch
```

Env file `~/.config/reading-list/apple-podcasts-sync.env` (chmod 600):

```
APPLE_PODCASTS_SYNC_URL=https://<prod host>/api/sync
SYNC_API_SECRET=<same value as Vercel's SYNC_API_SECRET>
# LOGGER_CLIENT_DIR=<directory with logger.py>   # optional failure reporting
```

## Install (launchd)

Requires the `apple_podcasts` sync_logs migration
(`supabase/migrations/20261005000000_add_apple_podcasts_sync_source.sql`) in
prod first.

macOS privacy controls (TCC) block a launchd-spawned shell from reading the
Podcasts app's Group Container (`Apple Podcasts DB unreadable: unable to open
database file`). So launchd runs a small ad-hoc-signed runner app,
`~/.claude/ApplePodcastsSync.app` (same pattern as `~/.claude/AwcAgent.app`),
which execs `launchd/run-sync.sh`, and **Full Disk Access is granted to that
app only**. Never grant it to `/bin/bash` (or `uv`/`python`) — that hands every
script on the machine unrestricted disk access.

```bash
launchd/build-runner.sh                      # builds + ad-hoc signs ~/.claude/ApplePodcastsSync.app
open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
#   → "+" → ⇧⌘G → ~/.claude/ApplePodcastsSync.app → enable it
cp launchd/com.claude.apple-podcasts-sync.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude.apple-podcasts-sync.plist
# re-run now:   launchctl kickstart gui/$(id -u)/com.claude.apple-podcasts-sync
# uninstall:    launchctl bootout gui/$(id -u)/com.claude.apple-podcasts-sync
```

Rebuilding the runner changes its ad-hoc signature, so macOS may drop the grant —
re-enable the app under Full Disk Access after any rebuild.

The runner runs `launchd/run-sync.sh` from the primary checkout
(`~/Programming/reading-list-worktrees/reading-list`). Logs:
`~/.claude/logs/apple-podcasts-sync-{stdout,stderr}.log`; each run also
writes a `sync_logs` row visible on `/settings/status`.

Do not move this job to the cloud — the data only exists on this Mac.
