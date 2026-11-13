#!/bin/bash
# launchd → this wrapper → tsx queue-curator/src/main.ts (the real run).
# Runs from the primary checkout's main, so a `git pull` there updates the
# job; the next hourly fire picks it up (nothing stays running in between).
# Secrets live in ~/.config/reading-list/queue-curator.env (chmod 600, never
# committed): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and optionally
# LOGGER_TOKEN, QUEUE_CURATOR_MODEL, QUEUE_CURATOR_CLAUDE_BIN.
set -euo pipefail

ENV_FILE="$HOME/.config/reading-list/queue-curator.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "$(date -u +%FT%TZ) FAILED to start: missing $ENV_FILE"
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# The env file may point the job at another checkout (QUEUE_CURATOR_REPO_DIR).
REPO_DIR="${QUEUE_CURATOR_REPO_DIR:-$HOME/Programming/reading-list-worktrees/reading-list}"

# launchd's PATH is minimal: node lives in Homebrew, claude in ~/.local/bin.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export QUEUE_CURATOR_CLAUDE_BIN="${QUEUE_CURATOR_CLAUDE_BIN:-$HOME/.local/bin/claude}"
# The claude child works in a scratch folder under the per-user temp dir.
export TMPDIR="${TMPDIR:-$(getconf DARWIN_USER_TEMP_DIR)}"
# This is the real run. A stray dry-run switch in the env file must not
# silently turn the hourly job into a no-op.
unset DRY_RUN
export QUEUE_CURATOR_REAL=1

cd "$REPO_DIR"
exec "$REPO_DIR/node_modules/.bin/tsx" queue-curator/src/main.ts
