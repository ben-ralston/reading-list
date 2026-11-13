"""Apple Podcasts listen progress → /api/sync entry point (#322).

Reads Askwho Casts play state from the Podcasts app's local database (read
only), maps it to /api/sync items keyed by `askwhocasts:<guid>`, and POSTs
the ones that changed since the last delivery (see state.py) in chunks as
source 'apple_podcasts'. Failures exit non-zero and go to the log service. All matching/guard logic lives in
the Next.js app (externalId-only match, never auto-add, Spotify's listening
rules); this stays thin, like substack_progress_sync.sync.

Run:  uv run python -m apple_podcasts_sync.sync [--dry-run]

Env:  APPLE_PODCASTS_SYNC_URL  full /api/sync URL
      SYNC_API_SECRET          shared secret (matches the Vercel app)
      APPLE_PODCASTS_DB        optional MTLibrary.sqlite override (tests)
      APPLE_PODCASTS_STATE     optional delivery-state file override (tests)
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys
from collections.abc import Callable, Iterator
from pathlib import Path

import httpx

from apple_podcasts_sync.build import build_items
from apple_podcasts_sync.reader import DEFAULT_DB_PATH, PodcastsDbError, read_episodes
from apple_podcasts_sync.state import (
    DEFAULT_STATE_PATH,
    changed_items,
    load_state,
    next_state,
    save_state,
)

CHUNK_SIZE = 50
SOURCE = "apple_podcasts"
LOG = "[apple-podcasts-sync]"

# A `post` takes the request body and returns the parsed JSON response,
# raising on any HTTP/transport error.
Post = Callable[[dict], dict]


def chunk_items(items: list[dict], size: int) -> Iterator[list[dict]]:
    """Yield successive `size`-length slices of `items`."""
    for i in range(0, len(items), size):
        yield items[i : i + size]


def post_all(
    items: list[dict],
    *,
    post: Post,
    secret: str,
    source: str = SOURCE,
    chunk_size: int = CHUNK_SIZE,
) -> dict:
    """POST `items` to /api/sync in chunks, accumulating the response counts.

    The route answers 200 even when item writes fail (`success: false`,
    `errors: N`), so those are accumulated too — a batch that lost writes
    must not look like a clean run. Re-raises whatever `post` raises.
    """
    summary: dict = {
        "chunks": 0,
        "processed": 0,
        "created": 0,
        "updated": 0,
        "skipped": 0,
        "errors": 0,
        "unmatched": [],
    }
    for batch in chunk_items(items, chunk_size):
        resp = post({"source": source, "secret": secret, "items": batch})
        summary["chunks"] += 1
        for key in ("processed", "created", "updated", "skipped"):
            summary[key] += int(resp.get(key, 0) or 0)
        errors = int(resp.get("errors", 0) or 0)
        if resp.get("success") is False and errors == 0:
            errors = 1
        summary["errors"] += errors
        summary["unmatched"].extend(resp.get("unmatched") or [])
    return summary


def ensure_podcasts_running(run=subprocess.run) -> None:
    """Sync Library only refreshes MTLibrary.sqlite while Podcasts runs, so
    launch it hidden (-g background, -j hidden) when it isn't. This run reads
    whatever is already synced; the next run picks up anything newer."""
    if run(["pgrep", "-x", "Podcasts"], capture_output=True).returncode != 0:
        run(["open", "-gj", "-a", "Podcasts"], check=False)


def report_failure(message: str, extra: dict | None = None) -> None:
    """Optionally send a failure to an external log service.

    Off by default: stderr and the exit code already report every failure. Set
    LOGGER_CLIENT_DIR to a directory holding a `logger.py` that exposes
    `log(app, level, message, json_extra=..., source=...)` to turn it on. The
    message is FIXED so a log service can group on it; details ride in `extra`.
    """
    client_dir = os.environ.get("LOGGER_CLIENT_DIR", "").strip()
    if not client_dir:
        return
    try:
        spec = importlib.util.spec_from_file_location(
            "reading_list_logger_client", Path(client_dir).expanduser() / "logger.py"
        )
        if spec is None or spec.loader is None:
            return
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.log("reading-list", "error", message, json_extra=extra, source="apple-podcasts-sync")
    except Exception:
        pass  # Logging is best-effort; stderr + the exit code still report it.


def _fail(reason: str, **extra) -> int:
    print(f"{LOG} FAILED: {reason}", file=sys.stderr)
    report_failure("apple-podcasts-sync failed", {"reason": reason, **extra})
    return 1


def _make_post(client: httpx.Client, url: str) -> Post:
    """Build a `post` callable backed by httpx that raises on non-2xx."""

    def post(payload: dict) -> dict:
        resp = client.post(url, json=payload, timeout=60.0)
        resp.raise_for_status()
        return resp.json()

    return post


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Sync Apple Podcasts listen progress to /api/sync"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Build and print the payload without POSTing.",
    )
    args = parser.parse_args(argv)

    # A dry run must be side-effect free, so it doesn't launch Podcasts.
    if not args.dry_run:
        ensure_podcasts_running()

    db_path = Path(os.environ.get("APPLE_PODCASTS_DB") or DEFAULT_DB_PATH)
    try:
        episodes = read_episodes(db_path)
    except PodcastsDbError as e:
        return _fail(str(e))

    items = build_items(episodes)
    state_path = Path(os.environ.get("APPLE_PODCASTS_STATE") or DEFAULT_STATE_PATH)
    state = load_state(state_path)
    to_send = changed_items(items, state)
    print(
        f"{LOG} {len(episodes)} played/in-progress AWC episodes → "
        f"{len(items)} syncable, {len(to_send)} changed"
    )

    if args.dry_run:
        print(json.dumps(to_send, indent=2))
        return 0
    if not to_send:
        return 0

    url = os.environ.get("APPLE_PODCASTS_SYNC_URL")
    secret = os.environ.get("SYNC_API_SECRET")
    if not url or not secret:
        return _fail("APPLE_PODCASTS_SYNC_URL / SYNC_API_SECRET not set")

    try:
        with httpx.Client() as client:
            summary = post_all(to_send, post=_make_post(client, url), secret=secret)
    except httpx.HTTPError as e:
        # Type + status only: the URL/secret never reach the log.
        status = getattr(getattr(e, "response", None), "status_code", None)
        return _fail(f"POST {type(e).__name__} {status or ''}".rstrip())
    except ValueError as e:
        # A non-JSON 2xx (e.g. a deployment-protection HTML page).
        return _fail(f"POST response was not JSON ({type(e).__name__})")

    print(
        f"{LOG} done: "
        f"{summary['chunks']} chunk(s), {summary['processed']} processed, "
        f"{summary['created']} created, {summary['updated']} updated, "
        f"{summary['skipped']} skipped, {summary['errors']} errors"
    )
    if summary["errors"]:
        # Don't save state: every changed item is retried next run.
        return _fail("item writes failed", errors=summary["errors"])

    save_state(state_path, next_state(state, to_send, summary["unmatched"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
