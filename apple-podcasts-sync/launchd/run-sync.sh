#!/bin/bash
# Apple Podcasts listen-progress sync (#322) — launchd entry point. Must run on
# the Mac: the play state only exists in the Podcasts app's local database.
#
# Runs out of the primary worktree's main checkout so `git pull` there updates
# the job. Secrets live in ~/.config/reading-list/apple-podcasts-sync.env
# (chmod 600, never committed): APPLE_PODCASTS_SYNC_URL, SYNC_API_SECRET.
set -euo pipefail

ENV_FILE="$HOME/.config/reading-list/apple-podcasts-sync.env"
REPO_DIR="$HOME/Programming/reading-list-worktrees/reading-list/apple-podcasts-sync"
UV="$HOME/.local/bin/uv"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[apple-podcasts-sync] missing $ENV_FILE — see apple-podcasts-sync/README.md" >&2
  exit 1
fi

set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

echo "[apple-podcasts-sync] run started $(date '+%Y-%m-%d %H:%M:%S')"
cd "$REPO_DIR"
exec "$UV" run python -m apple_podcasts_sync.sync "$@"
