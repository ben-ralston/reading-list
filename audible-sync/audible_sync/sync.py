"""Daily Audible → /api/sync entry point (#42).

Loads saved Audible credentials, fetches the full library, maps it to /api/sync
payload items, and POSTs them in chunks. All DB/merge logic lives in the Next.js
app; this stays thin. The chunked-POST accumulation core (`post_all`) is injected
with a `post` callable so it can be unit-tested without HTTP or auth.

Run:  uv run python -m audible_sync.sync [--dry-run]

Env:  AUDIBLE_AUTH_PATH    path to auth.json (default ./auth.json)
      AUDIBLE_WEBHOOK_URL  full /api/sync URL
      SYNC_API_SECRET      shared secret (matches the Vercel app)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Callable, Iterator

import httpx

from audible_sync.build import build_items

CHUNK_SIZE = 50
SOURCE = "audible"

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

    Chunking keeps each request well under the function timeout on a first
    full-library run and bounds the blast radius of any per-item failure (#42).
    Re-raises whatever `post` raises so the caller can exit non-zero.
    """
    summary = {"chunks": 0, "processed": 0, "created": 0, "updated": 0, "skipped": 0}
    for batch in chunk_items(items, chunk_size):
        resp = post({"source": source, "secret": secret, "items": batch})
        summary["chunks"] += 1
        for key in ("processed", "created", "updated", "skipped"):
            summary[key] += int(resp.get(key, 0) or 0)
    return summary


def _make_post(client: httpx.Client, url: str) -> Post:
    """Build a `post` callable backed by httpx that raises on non-2xx."""

    def post(payload: dict) -> dict:
        resp = client.post(url, json=payload, timeout=60.0)
        resp.raise_for_status()
        return resp.json()

    return post


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Sync Audible library to /api/sync")
    parser.add_argument(
        "--dry-run",
        "--print-only",
        action="store_true",
        dest="dry_run",
        help="Build and print the payload without POSTing.",
    )
    args = parser.parse_args(argv)

    auth_path = os.environ.get("AUDIBLE_AUTH_PATH", "auth.json")

    # Imported lazily so the testable core (chunk_items/post_all) and --dry-run
    # don't require the `audible` package or live credentials.
    from audible_sync.client import fetch_library, load_auth

    library = fetch_library(load_auth(auth_path))
    items = build_items(library)
    print(f"[audible-sync] {len(library)} library items → {len(items)} syncable")

    if args.dry_run:
        print(json.dumps(items, indent=2))
        return 0

    url = os.environ["AUDIBLE_WEBHOOK_URL"]
    secret = os.environ["SYNC_API_SECRET"]

    with httpx.Client() as client:
        summary = post_all(items, post=_make_post(client, url), secret=secret)

    print(
        "[audible-sync] done: "
        f"{summary['chunks']} chunk(s), {summary['processed']} processed, "
        f"{summary['created']} created, {summary['updated']} updated, "
        f"{summary['skipped']} skipped"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
