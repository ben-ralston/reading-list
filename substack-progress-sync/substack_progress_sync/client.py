"""Authenticated Substack reader-feed fetch (#192).

Auth is a single long-lived session cookie (``substack.sid``; formerly
``connect.sid``) sent as a Cookie header — no browser, no OAuth (Substack has
none for third parties). Only the
pagination core (`_fetch_all_pages`) and candidate merge (`_merge_candidates`)
carry logic and are unit-tested; `fetch_reader_posts` hits the real API and is
exercised via --dry-run.

Endpoint notes from the live investigation (2026-07-01):
- GET /api/v1/reader/posts?limit=N returns { posts, publications, inboxItems,
  more }. Each post carries id / slug / canonical_url / title / publication_id
  / read_progress / max_read_progress (0-1 floats, per authenticated user).
- Pagination: the endpoint IGNORES offset/page; the working cursor is
  ``after=<oldest inboxItems[].inbox_date of the previous page>`` (verified to
  return an older window). ``inboxItems`` are per-user state rows keyed by
  ``content_key: "post:<id>"``, not post objects.
- limit=25 errored while limit=10 worked — keep pages small.
- Undocumented API: stay at or under ~1 request/second.
"""

from __future__ import annotations

import time
from collections.abc import Callable

import httpx

BASE_URL = "https://substack.com"
READER_PATH = "/api/v1/reader/posts"

# limit=25 errored during the live investigation; 10 is known-good.
PAGE_LIMIT = 10

# ~300 posts per run. Progress is a monotonic high-water mark, so posts beyond
# the cap simply resurface on a later run once the closer ones stop changing.
MAX_PAGES = 30

# Undocumented API — stay at or under ~1 req/s.
MIN_INTERVAL_S = 1.0

USER_AGENT = "reading-list-substack-progress-sync/0.1 (personal reading tracker)"


def _auth_headers(sid: str) -> dict[str, str]:
    """Request headers carrying the session cookie under both known names.

    Substack renamed the session cookie ``connect.sid`` → ``substack.sid``
    (observed 2026-07-03; the value format is unchanged). The same value is
    sent under both names so whichever one the server's session middleware
    reads, it finds it — new sessions and any legacy ones both work.
    """
    return {
        "Cookie": f"substack.sid={sid}; connect.sid={sid}",
        "User-Agent": USER_AGENT,
    }


# A `get` takes the current cursor (None for the first page) and returns
# (posts, publications, more, next_cursor).
Get = Callable[[str | None], tuple[list[dict], list[dict], bool, str | None]]


def _merge_candidates(posts: list[dict], inbox_items: list[dict]) -> list[dict]:
    """Union of the feed's `posts` and any post-shaped `inboxItems`, deduped by id.

    In the live API, `inboxItems` are per-user state rows without a post id —
    those are dropped here, and `posts` (already enriched with the user's
    progress) is the real candidate source. Entries that nest a post under a
    `post` key or are post-shaped themselves are still accepted, so a future
    shape change degrades gracefully instead of crashing. On duplicate ids the
    `posts` entry wins.
    """
    merged: dict = {}
    for post in posts:
        post_id = post.get("id")
        if post_id is not None:
            merged.setdefault(post_id, post)
    for entry in inbox_items:
        post = entry.get("post") if isinstance(entry.get("post"), dict) else entry
        post_id = post.get("id")
        if post_id is not None:
            merged.setdefault(post_id, post)
    return list(merged.values())


def _fetch_all_pages(get: Get, *, max_pages: int) -> tuple[list[dict], dict]:
    """Accumulate reader pages until `more` is False or the page cap is hit.

    Returns (posts deduped by id, publications keyed by id). Stops early when
    the feed can't supply a next cursor or the cursor stops advancing — a feed
    that keeps saying `more` without moving would otherwise spin to the cap.
    """
    posts_by_id: dict = {}
    publications_by_id: dict = {}
    cursor: str | None = None
    pages = 0
    more = True

    while more and pages < max_pages:
        page_posts, page_publications, more, next_cursor = get(cursor)
        for post in page_posts:
            post_id = post.get("id")
            if post_id is not None:
                posts_by_id.setdefault(post_id, post)
        for publication in page_publications:
            publication_id = publication.get("id")
            if publication_id is not None:
                publications_by_id.setdefault(publication_id, publication)
        pages += 1
        if not next_cursor or next_cursor == cursor:
            if more:
                print(
                    "[substack-progress-sync] feed reports more pages but supplied "
                    "no advancing cursor — stopping with a partial harvest "
                    "(remaining posts resurface on a later run)"
                )
            more = False
            break
        cursor = next_cursor

    if more and pages >= max_pages:
        print(
            f"[substack-progress-sync] page cap ({max_pages}) reached — "
            "long-tail posts resurface on a later run"
        )

    return list(posts_by_id.values()), publications_by_id


def _oldest_inbox_date(inbox_items: list[dict]) -> str | None:
    """The oldest inbox_date on the page — the `after` cursor for the next one.

    ISO-8601 timestamps compare lexicographically, so min() is chronological.
    """
    dates = [d for d in (entry.get("inbox_date") for entry in inbox_items) if d]
    return min(dates) if dates else None


def fetch_reader_posts(
    sid: str,
    *,
    limit: int = PAGE_LIMIT,
    max_pages: int = MAX_PAGES,
    min_interval_s: float = MIN_INTERVAL_S,
) -> tuple[list[dict], dict]:
    """Fetch the authenticated reader feed, paginating politely.

    Returns (candidate posts, publications_by_id) ready for build_items.
    """
    with httpx.Client(
        base_url=BASE_URL, headers=_auth_headers(sid), timeout=30.0
    ) as client:
        first_request = True

        def get(cursor: str | None) -> tuple[list[dict], list[dict], bool, str | None]:
            nonlocal first_request
            if not first_request:
                time.sleep(min_interval_s)
            first_request = False

            params: dict = {"limit": limit}
            if cursor:
                params["after"] = cursor
            resp = client.get(READER_PATH, params=params)
            resp.raise_for_status()
            data = resp.json()

            inbox_items = data.get("inboxItems") or []
            candidates = _merge_candidates(data.get("posts") or [], inbox_items)
            return (
                candidates,
                data.get("publications") or [],
                bool(data.get("more")),
                _oldest_inbox_date(inbox_items),
            )

        return _fetch_all_pages(get, max_pages=max_pages)
