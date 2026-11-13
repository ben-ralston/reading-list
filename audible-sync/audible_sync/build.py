"""Pure functions that turn Audible library items into /api/sync payload items.

No network, no auth — every function here is deterministic over plain dicts so it
can be unit-tested in isolation (#42). The /api/sync route owns all
matching/dedup/merge logic; this module only shapes the request body.
"""

from __future__ import annotations

PLATFORM = "Audible"


def audible_external_id(asin: str) -> str:
    """Namespaced external id, matching the importer's ``goodreads:book:<id>``.

    Must stay byte-stable forever: the sync route's primary (Strategy-1) match
    is an exact ``external_id`` lookup, so idempotency across daily runs depends
    on this string never changing.
    """
    return f"audible:book:{asin}"


def map_status(is_finished: bool, percent_complete: float | None) -> str | None:
    """Map Audible listening state to a reading-list status.

    Finished → ``Completed`` (regardless of the reported percentage). Started but
    unfinished → ``In Progress``. Unstarted (0% or unknown) → ``None`` so the
    payload omits a status and the book lands queued, like a Goodreads "to-read".
    """
    if is_finished:
        return "Completed"
    if percent_complete and percent_complete > 0:
        return "In Progress"
    return None


def _build_item(library_item: dict) -> dict | None:
    """Build a single payload item, or None if the item can't be represented.

    Skips items missing an ASIN, title, or author — the /api/sync RPC rejects
    empty author/title anyway, so dropping them here avoids guaranteed
    server-side skips and keeps the payload clean.
    """
    asin = (library_item.get("asin") or "").strip()
    title = (library_item.get("title") or "").strip()
    if not asin or not title:
        return None

    authors = library_item.get("authors") or []
    author = (authors[0].get("name") if authors else "") or ""
    author = author.strip()
    if not author:
        return None

    pct = library_item.get("percent_complete")
    is_finished = bool(library_item.get("is_finished"))

    item = {
        "title": title,  # base title only — excluding the subtitle helps the
        "author": author,  # title+author merge with Goodreads books.
        "platform": PLATFORM,
        "kind": "book",
        "link": f"https://www.audible.com/pd/{asin}",
        "externalId": audible_external_id(asin),
        "progress": str(round(pct)) if pct is not None else "0",
    }

    status = map_status(is_finished, pct)
    if status is not None:
        item["status"] = status

    return item


def build_items(library_items: list[dict]) -> list[dict]:
    """Map a list of Audible library items to /api/sync payload items."""
    built = (_build_item(item) for item in library_items)
    return [item for item in built if item is not None]
