#!/bin/bash
# launchd → AwcAgent.app → this wrapper → tsx daemon (#317).
# Runs from the primary checkout's main, so a `git pull` there (plus
# `launchctl kickstart -k gui/$(id -u)/com.claude.awc-agent`) updates it.
set -euo pipefail

ENV_FILE="$HOME/.config/reading-list/awc-agent.env"
REPO_DIR="${AWC_AGENT_REPO_DIR:-$HOME/Programming/reading-list-worktrees/reading-list}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "$(date -u +%FT%TZ) FAILED to start: missing $ENV_FILE"
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# The Chrome bridge socket lives under the per-user temp dir; make sure the
# daemon (and the claude child it spawns) see the real one.
export TMPDIR="${TMPDIR:-$(getconf DARWIN_USER_TEMP_DIR)}"
export AWC_AGENT_REPO_DIR="$REPO_DIR"

cd "$REPO_DIR"
exec "$REPO_DIR/node_modules/.bin/tsx" awc-agent/src/daemon.ts
