"""Hourly Substack read-progress → /api/sync entry point (#192).

Fetches the authenticated reader feed, maps started posts to /api/sync payload
items, and POSTs them in chunks. All matching/guard logic lives in the Next.js
app; this stays thin (mirrors audible_sync.sync). The chunked-POST accumulation
core (`post_all`) is injected with a `post` callable so it can be unit-tested
without HTTP or auth.

Run:  uv run python -m substack_progress_sync.sync [--dry-run]

Env:  SUBSTACK_SID           substack.sid session cookie value (legacy name: connect.sid)
      SUBSTACK_WEBHOOK_URL   full /api/sync URL
      SYNC_API_SECRET        shared secret (matches the Vercel app)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Callable, Iterator

import httpx

from substack_progress_sync.build import build_items

CHUNK_SIZE = 50
SOURCE = "substack"

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

    Chunking keeps each request well under the function timeout and bounds the
    blast radius of any per-item failure. Re-raises whatever `post` raises so
    the caller can exit non-zero.
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
    parser = argparse.ArgumentParser(
        description="Sync Substack read progress to /api/sync"
    )
    parser.add_argument(
        "--dry-run",
        "--print-only",
        action="store_true",
        dest="dry_run",
        help="Build and print the payload without POSTing.",
    )
    args = parser.parse_args(argv)

    sid = os.environ["SUBSTACK_SID"]

    # Imported lazily so the testable core (chunk_items/post_all) doesn't pull
    # in the network client.
    from substack_progress_sync.client import fetch_reader_posts

    posts, publications_by_id = fetch_reader_posts(sid)
    items = build_items(posts, publications_by_id)
    print(f"[substack-progress-sync] {len(posts)} reader posts → {len(items)} syncable")

    if args.dry_run:
        print(json.dumps(items, indent=2))
        return 0

    url = os.environ["SUBSTACK_WEBHOOK_URL"]
    secret = os.environ["SYNC_API_SECRET"]

    with httpx.Client() as client:
        summary = post_all(items, post=_make_post(client, url), secret=secret)

    print(
        "[substack-progress-sync] done: "
        f"{summary['chunks']} chunk(s), {summary['processed']} processed, "
        f"{summary['created']} created, {summary['updated']} updated, "
        f"{summary['skipped']} skipped"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
