"""Pure functions that turn Substack reader posts into /api/sync payload items.

No network, no auth — deterministic over plain dicts, unit-tested in isolation
(#192, mirroring audible_sync.build). The /api/sync route owns all matching
logic; this module only shapes the request body.
"""

from __future__ import annotations

PLATFORM = "Substack"


def substack_external_id(post_id: int | str) -> str:
    """Namespaced external id, matching ``audible:book:<asin>`` / ``goodreads:book:<id>``.

    Must stay byte-stable forever: the sync route's primary (Strategy-1) match
    is an exact ``external_id`` lookup, so idempotency across repeated runs depends
    on this string never changing.
    """
    return f"substack:post:{post_id}"


def map_status(progress_percent: int) -> str | None:
    """Map a read percentage to a reading-list status.

    Mirrors the Spotify sync's determineStatus thresholds
    (lib/spotify/transform.ts): >= 97% → ``Completed`` (paywalled posts top out
    near 100% at the paywall, so treat near-complete as read); <= 1% → ``None``
    (a glance, not a read — callers drop these); otherwise ``In Progress``.
    """
    if progress_percent >= 97:
        return "Completed"
    if progress_percent <= 1:
        return None
    return "In Progress"


def _resolve_author(post: dict, publications_by_id: dict) -> str:
    """Author = publication name, falling back to the first byline.

    The app stores Substack items with ``author = publication name`` (the RSS
    importer stamps the feed's authorName onto every item), so sending the same
    value is what makes the title+author match (Strategy 2/3) land. The byline
    fallback keeps a post syncable when its publication isn't in the response,
    at the cost of a lower match rate.
    """
    publication = publications_by_id.get(post.get("publication_id")) or {}
    author = (publication.get("name") or "").strip()
    if author:
        return author

    bylines = post.get("publishedBylines") or []
    return ((bylines[0].get("name") if bylines else "") or "").strip()


def _build_item(post: dict, publications_by_id: dict) -> dict | None:
    """Build a single payload item, or None if the post can't be represented.

    Drops posts that are unstarted / barely started (<= 1%, mirroring the
    Spotify sync's drop threshold) and posts missing an id, title, or
    resolvable author — the /api/sync route skips author-less items anyway.
    """
    post_id = post.get("id")
    title = (post.get("title") or "").strip()
    if not post_id or not title:
        return None

    # int(x + 0.5) = half-up; Python's round() is banker's rounding, which
    # would let 96.5 land on 96 and dodge the >=97 Completed threshold.
    percent = int(min(1.0, max(0.0, post.get("max_read_progress") or 0)) * 100 + 0.5)
    status = map_status(percent)
    if status is None:
        return None

    author = _resolve_author(post, publications_by_id)
    if not author:
        return None

    item = {
        "title": title,
        "author": author,
        "platform": PLATFORM,
        "externalId": substack_external_id(post_id),
        "progress": str(percent),
        "status": status,
    }

    link = (post.get("canonical_url") or "").strip()
    if link:
        item["link"] = link

    return item


def build_items(posts: list[dict], publications_by_id: dict) -> list[dict]:
    """Map reader-feed posts to /api/sync payload items."""
    built = (_build_item(post, publications_by_id) for post in posts)
    return [item for item in built if item is not None]
