# queue-curator

Claude chooses and orders the owner's shortlist of things to read or listen to next.

It runs two ways:

- **The real run** (`QUEUE_CURATOR_REAL=1`, set only by the launchd wrapper): hourly. It runs the agent session, validates the picks, and saves one `curation_runs` row plus its notes. It skips the model call when nothing it would show Claude has changed since the last good run (and that run is under 24 hours old). A failed run saves a `failed` row and leaves the previous picks and notes in place, and the same input is not retried for 6 hours. Without either switch `main.ts` refuses to run, so a stray command cannot write to production. It never writes `content_items`.
- **The dry run** (`DRY_RUN=1`): the same read and ranking, printed, with no database write. Works against a database that does not have the curation migration yet.

The app's home screen shows the latest succeeded run's picks (#377): pins first, then these picks, then a formula fallback, eight in all.

There are two modes. **`agent` is the one the real run uses**; `simple` is kept as the cheap baseline.

| | `simple` (dry run only, the default there) | `agent` (the real run; `QUEUE_CURATOR_MODE=agent` in a dry run) |
|---|---|---|
| Session | one answer, no tools | multi-step, file and web tools, no shell |
| Sees | a digest: every active item, per-author counts, last 100 finished / skipped titles | a scratch folder: `queue.jsonl` (with links and summary bullets), the full `history.jsonl`, `instructions.md`, `memory.md` |
| Answer | structured output | writes `picks.json` in the folder |
| Memory | none | reads and rewrites `memory.md`; kept between runs |
| Time on Opus | about 25 s | about 2 min |

```
Supabase (read-only) ─▶ digest.ts ─┬─▶ prompt.ts ─▶ claude, no tools ─────────────┐
                                   └─▶ workspace.ts ─▶ claude in a scratch folder ─┤
                                        (Read, Grep, Glob, Write, Edit,            │
                                         WebSearch, WebFetch)                      ▼
                                                              picks.ts (validate) ─▶ printed list
```

## Dry run

Against production, read-only, from the repo root:

```bash
set -a; source .env.local; set +a
PROJECT_REF=$(echo "$POSTGRES_URL" | sed -n 's/.*postgres\.\([^:]*\):.*/\1/p')
export SUPABASE_URL="https://${PROJECT_REF}.supabase.co" DRY_RUN=1
pnpm exec tsx queue-curator/src/main.ts                           # simple
QUEUE_CURATOR_MODE=agent pnpm exec tsx queue-curator/src/main.ts  # agent
```

It uses the `claude` CLI's own login, not the app's Anthropic API key. Optional env: `QUEUE_CURATOR_MODEL` (default `opus`), `QUEUE_CURATOR_CLAUDE_BIN` (default `claude`), `QUEUE_CURATOR_MEMORY_FILE` (default `~/.local/state/reading-list/queue-curator-memory.md`).

Agent mode prints what the session did (tool counts, pages fetched, searches) before the picks, and says whether the notes changed. The notes file is the one thing a dry run saves, and it is on the Mac, not in the database. Notes over 6,000 characters, or from a run with no usable picks, are not kept.

## The hourly job

`launchd/com.claude.queue-curator.plist` fires at :45 every hour from 05:45 to 21:45 local time (and once at load, and once after a wake that missed runs). From 10 pm to 5 am the job does nothing even if launchd starts it (`inQuietHours` in `src/curate.ts`), so the first run of the day is 05:45. Each fire runs `launchd/run-curator.sh` from the primary checkout's `main`. Nothing stays running between fires, so a `git pull` there is all an update needs. A run takes about two minutes on Opus when something changed, and a second or two when it skips.

### One-time setup

1. Apply migration `20261109000000_add_curation.sql` to production (`./run deploy`).
2. Secrets file (`chmod 600`) at `~/.config/reading-list/queue-curator.env`:
   ```bash
   SUPABASE_URL=https://<project-ref>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=...
   LOGGER_TOKEN=...               # log service write token, for failure reports
   # optional: QUEUE_CURATOR_MODEL=sonnet   (default opus)
   ```
3. Install and start:
   ```bash
   cp queue-curator/launchd/com.claude.queue-curator.plist ~/Library/LaunchAgents/
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude.queue-curator.plist
   ```
   Run it now: `launchctl kickstart gui/$(id -u)/com.claude.queue-curator`. Remove it: `launchctl bootout gui/$(id -u)/com.claude.queue-curator`.
4. Optionally point a log watcher at the status log. The patterns to match:
   ```yaml
   - name: queue-curator
     # reading-list: hourly at :45. Each run ends in one status line:
     # "ok: …", "skipped: …" or "FAILED: …".
     log_file: "~/.claude/logs/queue-curator.log"
     success_pattern: "ok:|skipped:"
     failure_pattern: "FAILED"
   ```

The job is plain `/bin/bash`, not a signed runner app like `awc-agent`: it touches no folder macOS protects. If `claude` cannot reach its login from launchd (the log shows an authentication failure), switch to the runner-app pattern in `awc-agent/launchd/`.

### Reading the log

`~/.claude/logs/queue-curator.log` gets one timestamped line per run:

```
2026-11-10T02:45:07.412Z ok: 22 picks, 322 candidates, tools Read 7 Grep 6 Write 2, 0 dropped, notes updated (3287 characters)
2026-11-10T03:45:01.120Z skipped: nothing changed since the last run 1.0 h ago
2026-11-10T04:12:09.530Z skipped: quiet hours (10 pm to 5 am)
2026-11-10T04:47:31.004Z FAILED: claude timed out after 1500 s
```

A `FAILED` line also goes to the log service (`app: reading-list`, `source: queue-curator`, fixed message `queue curation failed` and a fixed category such as `agent_failed` or `no_usable_picks`), which the alerting job can turn into an alert. The error text itself, which can contain words from the model or a feed, stays in the log and the `curation_runs.error` column. `queue-curator-stderr.log` holds the CLI's own stderr.

### Claude's notes

The agent's notes about the owner's taste live in `app_settings` under the key `queue_curator_memory` (6,000 characters at most). Edit that row to correct them; the next run reads the edited text. A dry run in agent mode uses a local file instead (`QUEUE_CURATOR_MEMORY_FILE`), so it never touches the saved notes.

### The owner's overrides

The migration also adds `content_items.pinned_at` ("Make next") and `shortlist_dismissed_at` ("Not now"), both cleared by a trigger when an item is completed or skipped. The app sets them: Make next (and hand-adds and archive restores) pins, Not now dismisses. The curator honours them: a pinned item is marked so Claude does not spend a pick on it, and a dismissed item is left out for 21 days (`DISMISS_HOLD_DAYS`, shared with the app from `lib/shortlist.ts`), then offered again with its dismissal date.

## Files

- `instructions.md`: the owner's standing instructions, in their own words. The file in this repository is an invented example; edit freely.
- `prompt.md`: the simple mode's prompt template (`{{TODAY}}`, `{{INSTRUCTIONS}}`, `{{DATA}}`). Bump `PROMPT_VERSION` in `src/prompt.ts` when it changes.
- `prompt-agent.md`: the agent mode's prompt (`{{TODAY}}`, `{{COUNT}}`, `{{MEMORY_CHARS}}`).
- `src/workspace.ts`: the files the agent gets. `src/trace.ts`: what it did, read from its output stream.
- `src/digest.ts`: rows to candidates and the history digest. Learns from finished and skipped items only; `status_changed_at` is passed along as approximate.
- `src/picks.ts`: parses and validates the answer. Unknown, repeated or malformed entries are dropped, at most 25 kept, reasons over 60 characters blanked; no valid pick fails the run.
- `src/claude-args.ts`: the CLI arguments for both modes and the child env.
- `src/curate.ts`: the real run. `src/hash.ts`: the unchanged-input fingerprint. `src/store.ts`: the only database writes. `src/spawn.ts`: the child process, with timeout and exit handling. `src/ulog.ts`: failure reports.

## Safety

Titles, authors, labels, summaries and web pages are untrusted text.

- **Both modes:** the Supabase service-role key stays in the parent process; the child's env is `HOME`, `PATH`, `TMPDIR`, `USER`. Claude never touches the database: it reads exported data and proposes picks and notes, and the job validates the picks (real ids, no repeats, short clean reasons).
- **Simple mode** has no tools at all, so hostile text can at worst skew a ranking.
- **Agent mode** accepts more risk, deliberately: a session that reads untrusted text and can request URLs could in principle be steered into leaking what is in its folder (the queue and reading history) through a request, or into writing something odd into its notes. What bounds it: no shell, file access confined to the scratch folder (probe-verified: reads and writes outside it are refused), validated picks, and a size cap on notes, which the owner can read and edit.

## Tests

`pnpm exec vitest run queue-curator`. These never spawn `claude` or touch a database. The migration has its own suite, `supabase/curation.integration.test.ts`, which needs the local stack.
