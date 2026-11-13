# awc-agent

A launchd daemon on a Mac that turns **Convert with Askwho Casts** taps into Askwho Casts (AWC) episodes with no manual steps in the AWC UI (#317).

```
tap Convert (PWA) ─▶ POST /api/queue {action:'requestAwcConversion'} ─▶ awc_conversions row (queued)
                                                                              │
awc-agent daemon (this dir, every 5 s) ─ claim_awc_conversion() ◀─────────────┘
   └─ claude --print --chrome (browser tools only) drives askwhocasts.com
        URL check first; a Studio script (multi-voice) when AWC can't fetch / paywall stub;
        fails "paywalled" without spending credits when the signed-in browser session can't read the full post either
        reports stages: submitting_url → building_script → generating
AWC private feed ─▶ askwhocasts-sync (cron + daemon nudges every 2 min) ─▶ episode attached, row done
```

Convert is offered on any feed item with a readable article link, including posts that already have audio such as Spotify, because an Askwho Casts reading is usually much better (#364). `lib/awc/eligibility.ts` decides this for both the menu and the API, and the article URL is what gets submitted. It isn't offered on books, audio with no article, or posts that already have Askwho audio (a private episode, or a copy from the public "AI Article Readings" show). Once a post has an episode, START opens it. From the moment Convert is tapped, the Spotify sync's status and progress are ignored for that item, so an old played episode can't complete it. Apple Podcasts still can, and the row stops counting if the conversion fails.

The card shows the stage live (the home page polls `GET /api/awc-conversions` every 4 s while something is converting), "Queued · Mac offline" when the daemon's heartbeat is stale, and Retry / "Open Askwho Casts manually" after a failure.

## Comments episodes (#368)

**Convert comments with Askwho Casts** appears on any LessWrong post, once per post, whether or not the article has audio. The flow differs from an article's in one way: the daemon, not the agent, reads the source.

```
tap (PWA) ─▶ awc_conversions row, kind 'comments' ─▶ daemon claims it
   daemon: LessWrong GraphQL ─▶ comments-script.ts ─▶ empties the clipboard ─▶ starts the agent
   agent: Library ▸ marker (daemon places script) ▸ Studio ▸ paste ▸ check counts ▸ Auto Cast ▸ Record ▸ price check ▸ Make the episode
AWC private feed ─▶ askwhocasts-sync ─▶ second Askwho Casts source, source_label 'Comments'
```

- **What's included:** every comment that isn't deleted or rejected, whatever its karma. Over 90 minutes (14,400 rendered words), the highest-scoring comments stay, with whatever ancestors they need to make sense; a thread that lost replies ends by saying how many, and the ending gives the total left out. Under 200 words fails with "too few comments yet" before the agent starts, and the card says **Comments: Too few yet**; Retry reads the comments again.
- **The script:** `src/comments-script.ts` builds it deterministically. AWC finds speakers from double quotes and starts a chapter at a line beginning with `#`, so each comment is one line, inner double quotes become single quotes, and block quotes are read by the narrator. The second line says when the comments were fetched (`Comments as of Saturday, November 7, 2026 at 9:46 AM Central Standard Time.`, in the Mac's time zone), and each comment opens name first, in the order LessWrong shows it: `Raemon, replying to Maya, 2 days ago, 5 karma, 7 agreement, says: "..."`. A jump back up the tree says where it lands (`Back to the top comment, by Maya.` or `Back to Maya's reply to dvd.`), and each thread heading gives its size (`## Thread 2 of 14, 6 comments`). The agent never sees the text as data, and only the counts it must check enter the prompt.
- **Clipboard:** the daemon saves and empties it before the agent starts, so a paste that comes too early finds nothing. It places the script when the agent writes `AWC_STAGE: building_script`, just before the paste, and restores the original afterwards, unless something new was copied during the run. Anything copied before that marker is overwritten. Something copied in the few seconds between the marker and the paste would be pasted instead; the agent's count check then stops the run, though that text is already in the Studio draft.
- **Casting:** Auto Cast, on this path only. Hand casting takes about 8 tool calls a line, so a thread would hit the 250-turn limit. Its price depends on length (2 credits for 89 minutes). In testing it placed 132 of 132 lines correctly across 79 characters with 79 distinct voices. It picks voice gender from the username, which is often wrong. AWC sends the text to OpenAI and Anthropic to do this; these are public comments.
- **Credits:** the tap is the approval, as for articles, with one extra guard: a price over 100 credits on Record fails with `over credit cap`. A Studio episode has no link and attaches only by its exact title, so if `/library` already lists that title the run doesn't pay again: it reports `generating`, which lets the existing episode attach.
- **Isolation:** the same as articles, but the nav allowlist is Askwho Casts only, because the agent has no reason to open LessWrong. The profile's residual risk under Policy still applies.
- **Listening:** a comments source never counts as the article's audio: START doesn't open it, it doesn't hide Convert or ElevenReader, it stays out of the Audio filter, and it doesn't block Spotify progress. In Apple Podcasts it records only its own position, and finishing it completes the card if the card is Awaiting comments, including when the article finished in the same sync batch. Otherwise it changes nothing, so comments finished before the article, in an earlier sync, leave the card waiting for Done. One episode per post: there's no redo once it exists.

## Policy

- **Credits:** tapping Convert is the approval. The agent clicks Generate without asking and with no cap.
- **ToS:** AWC has no API and its terms (§4) forbid scripting the backend. The agent only uses the visible web UI and never gets `javascript_tool`.
- **Isolation:** the agent reads untrusted web pages, so its session runs with `--restricted --tools "" --strict-mcp-config`. It has no shell, no file access and no other MCP servers, only the claude-in-chrome browser tools (see `src/claude-args.ts`). Its env holds only `HOME`, `PATH`, `TMPDIR` and `USER`, so it never sees any secret.
  - A `PreToolUse` hook (`src/nav-hook.ts`, passed via `--settings`) **denies any `navigate`** to a host other than Askwho Casts or the item's own site before it runs. The daemon also watches the live stream and kills the session if one slips through (`src/nav-guard.ts`).
  - **Residual risk, so choose the Chrome profile carefully.** The guard can't see link clicks made via `computer`, and the agent drives whatever that profile is signed into. A malicious article could try to steer it to another signed-in site in the same profile; a general-purpose profile may hold sessions for unrelated sites. Prefer a profile signed into only Askwho Casts and the publications you convert from. Alternatively, use Claude in Chrome's per-site permissions to limit that profile to those sites.
- **AWC sign-in recovery (#339):** if the AWC session has expired, the agent's first `/library` load lands on AWC's sign-in page. The prompt then allows exactly one recovery, with clicks only and before any article has been read: "Continue with Google", then the `reader@example.com` row in Google's account chooser (a normal page, not a FedCM prompt; another account is listed first, so the agent picks the row by its address). The agent never types on Google and never navigates there itself, and Google is not on the nav allowlist. A password, 2FA or consent prompt, or a sign-in page at any later point, still stops the run with `not signed in to askwhocasts.com`. The card then shows **AWC signed out**: sign in by hand in that Chrome profile and tap Retry.
- **Complete text only (#363):** a Script-path episode is the whole article. The agent selects it in the article tab and moves it with real cmd+c / cmd+v key presses, so it never passes through model output, where a model may summarise instead of copying. The daemon empties the Mac's clipboard when a Script run starts, because a failed cmd+c would otherwise paste whatever was last copied into AWC, and restores its text when the run ends. If it can't empty the clipboard, the run stops before any credits are spent. One gap remains: text copied in the half minute or so between the agent's cmd+c and cmd+v would be pasted into AWC instead of the article. Anything copied during those few minutes is lost, as is an image on the clipboard. The pasted text stays in a Studio draft in the AWC account until the episode is made. The agent checks the paste (opening, ending, AWC's word count) and the price (at least the larger of AWC's reported length and `word_count` ÷ 230) before Generate, and otherwise fails with `could not include full text`.
- **Short episodes (#363):** after the run, the daemon compares credits with `max(reported_words, word_count)`. A complete article costs about 175 words a credit, or 0.85 of length / 150, and anything under 65% is flagged. Credits are already spent and the episode reaches the feed either way, so the run isn't failed. The warning goes in `error`, the row still closes normally, and the card keeps a **Short episode** pill with the reason as a tooltip. It logs as `warn` (`awc short episode`). The pill can't be dismissed and the card offers no redo. A redo by hand from the article's URL replaces the attached link, but a Studio redo has no link and doesn't attach, since link-less episodes only match a `generating` row. Either way the pill stays until the item leaves the queue.
- **Credits after a crash:** once the agent reports `generating` (right after clicking Generate), a later timeout or crash still records the conversion as generating, never failed, so Retry can't pay twice. A run that stalls mid-way (before `generating`) is failed with "check Askwho Casts before retrying" rather than retried automatically.

## One-time setup

1. **Chrome profile:** in the Chrome profile paired with Claude in Chrome (the one the daemon should drive), sign in to:
   - askwhocasts.com (magic link or Google)
   - your Substack account (and any other paywalled sites you convert from). Paid-only posts need a paid subscription to that publication; otherwise the agent fails the conversion as "paywalled" before spending credits
2. **Secrets file** (`chmod 600`), at `~/.config/reading-list/awc-agent.env`:
   ```bash
   SUPABASE_URL=https://<project-ref>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=...
   SYNC_API_SECRET=...            # same value as Vercel's SYNC_API_SECRET
   DEPLOY_URL=https://<prod alias>
   # DRY_RUN=1                    # stage everything but never click Generate
   ```
3. **Dependencies:** run `pnpm install` in the primary checkout (`~/Programming/reading-list-worktrees/reading-list`), which provides `tsx`.
4. **Runner + launchd:**
   ```bash
   awc-agent/launchd/build-runner.sh                       # builds ~/.claude/AwcAgent.app
   cp awc-agent/launchd/com.claude.awc-agent.plist ~/Library/LaunchAgents/
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude.awc-agent.plist
   ```
   Optional settings in the env file: `AWC_AGENT_ENSURE_CHROME_SCRIPT` (a script run before each conversion to make sure Chrome is open on the right profile; it receives the two parts of `AWC_AGENT_CHROME_PROFILE`, default `Profile 1|Claude for Chrome`) and `AWC_AGENT_REFERENCE_FILE` (a Markdown file of operator notes on the Askwho Casts UI, appended to the prompt). Without them the daemon assumes Chrome is already running and sends the prompt without notes. If the helper script drives System Events, macOS asks once to allow AwcAgent to control it.
5. **Monitoring (optional):** point a log watcher at `~/.claude/logs/awc-agent.log`: a `FAILED` line is a failure, and no new line for 3 minutes means the daemon has stalled.

## Operating

| Task | Command |
|---|---|
| Status log (heartbeat every 60 s) | `tail -f ~/.claude/logs/awc-agent.log` |
| One attempt's Claude transcript | `~/.claude/logs/awc-agent/conv-<id>-a<attempt>-<date>.jsonl` |
| Restart after `git pull` | `launchctl kickstart -k gui/$(id -u)/com.claude.awc-agent` |
| Stop / uninstall | `launchctl bootout gui/$(id -u)/com.claude.awc-agent` |
| Requests | `select id, content_item_id, status, path, error from awc_conversions order by id desc limit 20;` |

Errors go to the external log service, when one is configured, as `app: reading-list`, `source: awc-agent` (fixed messages: `awc conversion failed`, `awc claim failed`, …). A paywall stop ("paywalled — not a paid subscriber to <host>") is expected, so it logs as `warn` (`awc conversion paywalled`), not `error`. The same goes for an AWC sign-out the agent couldn't recover from (`awc signed out`): the card already says "AWC signed out".

Network blips (#366): a claim poll or heartbeat write that fails with a transport error (`fetch failed`, `ECONNRESET`, `ETIMEDOUT`, DNS…) logs `warn` (`awc claim failed`, `awc heartbeat failed`), and the status log prints ONE `poll retrying: …` / `heartbeat retrying: …` line, then goes quiet. A log watcher that judges the last line therefore sees no FAILED for a blip, while the missing `heartbeat ok` lines show a longer outage as a stale log (3 min). A streak is failures no more than 3 minutes apart; successes in between don't end it, and a longer gap (the Mac asleep) does. Once a streak has lasted 10 minutes the daemon sends ONE `error` row (with `failures` and `failingForSec`) and prints FAILED lines until it recovers. Recovery, after 3 minutes without a failure, logs `info` once (`awc claim recovered`, `awc heartbeat recovered`) and prints `poll recovered`. Any other error (a missing RPC, a permission error) is still `error` at once, as is a throw while running a claimed conversion (`awc conversion crashed`).

One instance at a time (#366): the daemon holds a Unix-socket lock at `~/.local/state/reading-list/awc-agent.sock`. A second copy prints `another awc-agent is already running (lock …); waiting for it to stop` once and waits, idle, retrying every 15 s, and takes over when the holder stops. It doesn't exit, because launchd's KeepAlive would restart it every 10 s. A crashed or killed holder leaves a dead socket that the next start replaces (every start binds under an `.acquire` mutex, so two starters can't both take it), so a crash or reboot never blocks the KeepAlive restart. If something that is not a socket sits at the lock path, the daemon refuses to start rather than delete it.

Stuck rows heal on their own:
- the claim RPC requeues a row stuck in `starting` for 20 min, and fails it after 2 attempts;
- it fails a row stalled mid-run;
- it marks `generating` rows failed after 24 h with no episode.

## Local testing (`DRY_RUN=1` never spends credits)

```bash
./run db-start && ./run dev --local-db
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=<local service key> \
SYNC_API_SECRET=x DEPLOY_URL=http://localhost:3000 AWC_AGENT_REPO_DIR=$PWD DRY_RUN=1 \
  pnpm exec tsx awc-agent/src/daemon.ts
```

While the launchd daemon is running, add `AWC_AGENT_LOCK_PATH=$TMPDIR/awc-agent-local.sock` so the local copy doesn't sit waiting for the live one (only against the local DB: two daemons on one database race for claims).

Tap Convert on a text item. The card should go Queued → Starting → Submitting (→ Writing script) → Failed "dry run — episode not made".

For comments, `DRY_RUN=1` stops at the Cast step without spending anything. `DRY_RUN=cast` also runs Auto Cast (about 2 credits) and stops on Record, as a rehearsal of everything except recording.
