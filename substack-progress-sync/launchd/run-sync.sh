#!/bin/bash
# Hourly Substack read-progress sync (#192, hosting moved to launchd in #198) —
# launchd entry point. Substack's Cloudflare 403s datacenter IPs (GitHub
# Actions runners), so this job runs from the Mac's residential IP instead.
#
# Runs out of the primary worktree's main checkout so `git pull` there updates
# the job. Secrets live in ~/.config/reading-list/substack-sync.env (chmod 600,
# never committed): SUBSTACK_SID, SUBSTACK_WEBHOOK_URL, SYNC_API_SECRET.
set -euo pipefail

ENV_FILE="$HOME/.config/reading-list/substack-sync.env"
REPO_DIR="$HOME/Programming/reading-list-worktrees/reading-list/substack-progress-sync"
UV="$HOME/.local/bin/uv"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[substack-progress-sync] missing $ENV_FILE — see substack-progress-sync/README.md" >&2
  exit 1
fi

set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

echo "[substack-progress-sync] run started $(date '+%Y-%m-%d %H:%M:%S')"
cd "$REPO_DIR"
exec "$UV" run python -m substack_progress_sync.sync "$@"
