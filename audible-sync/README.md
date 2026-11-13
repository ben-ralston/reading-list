# audible-sync (#42)

Daily sync of Audible audiobook progress into the reading-list app. Fetches your
Audible library with the [`mkb79/audible`](https://github.com/mkb79/audible)
device-auth library and POSTs it to the app's `/api/sync` webhook with
`kind: "book"`, so audiobooks **merge into** your existing Goodreads books
(progress + an Audible source attached, no duplicates) and new ones are added to
`/books`. Finished audiobooks are marked **Completed**.

Runs on a **GitHub Actions** daily cron (`.github/workflows/audible-sync.yml`).
A daily cadence makes GHA's cron drift irrelevant, unlike the time-sensitive
RSS/Spotify syncs on the Cloudflare Worker.

## Layout

```
audible-sync/
  audible_sync/
    build.py     # pure: library item dicts → /api/sync payload items (unit-tested)
    client.py    # auth + paginated library fetch (mkb79/audible)
    sync.py      # entry point: load auth → fetch → build → chunked POST
  bootstrap.py   # one-time human 2FA login → auth.json
  tests/         # pytest (build / sync / client)
```

All matching/dedup/merge logic lives in the Next.js app (`/api/sync`); this stays
thin.

## Local development

```bash
uv sync                        # install deps + this package (editable)
uv run pytest                  # run the unit tests
uv run python -m audible_sync.sync --dry-run   # build + print payload, no POST
```

`--dry-run` (alias `--print-only`) needs a valid `auth.json` (it still fetches the
real library) but POSTs nothing — use it to eyeball the payload before the first
real run.

## One-time auth bootstrap (human, 2FA)

Audible has no public API and login requires real 2FA, so this step **cannot be
automated** — you run it yourself, once:

```bash
cd audible-sync
uv run python bootstrap.py
```

It prints an Amazon login URL. Open it in a browser, sign in (completing 2FA),
and paste the final redirect URL back. It writes `auth.json`.

Then store the credentials as a GitHub repo secret (base64 so the JSON survives
intact):

```bash
base64 -i auth.json | pbcopy        # macOS — now paste into the secret value
# or: base64 -w0 auth.json          # Linux
```

`auth.json` is git-ignored — **never commit it.** The durable credentials in it
(refresh token + device private key) are long-lived; the short-lived access token
is refreshed in memory on each run and never written back, so the same `auth.json`
keeps working for months. Re-run `bootstrap.py` only if you change your Amazon
password or deregister the device.

## GitHub configuration

In the repo's **Settings → Secrets and variables → Actions**:

| Name | Kind | Value |
| --- | --- | --- |
| `AUDIBLE_AUTH_B64` | Secret | base64 of `auth.json` (above) |
| `SYNC_API_SECRET` | Secret | same value as the Vercel app's `SYNC_API_SECRET` |
| `AUDIBLE_WEBHOOK_URL` | Variable | `https://<prod-app>/api/sync` |

The workflow decodes `AUDIBLE_AUTH_B64` to `auth.json` at runtime, runs the sync,
then deletes it. Trigger it manually (with an optional dry-run) from the
**Actions** tab via *Run workflow*; otherwise it runs daily at ~09:00 UTC.

## How it appears in the app

Each run writes a `sync_logs` row with `source='audible'`; chunked POSTs (50
items each) produce one row per chunk. The Status page (`/settings/status`) shows
an **Audible** section once the first run lands, with per-run `N added, M updated,
K skipped` counts — a high skipped count is the signal to check the Actions log.
