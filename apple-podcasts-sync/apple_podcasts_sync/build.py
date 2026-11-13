"""Apple Podcasts episode → /api/sync payload mapping (#322).

Pure: no I/O. Completion thresholds mirror lib/spotify/transform.ts
`determineStatus` so an Askwho Casts episode finished in Apple Podcasts is
treated exactly like a Spotify listen. Items are keyed by the episode's RSS
GUID, which the askwhocasts-sync cron stores as `askwhocasts:<guid>` on the
item's content_sources row — the route matches on that ID only.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import dataclass

# ZMTEPISODE.ZPLAYSTATE values observed in MTLibrary.sqlite.
PLAYED, IN_PROGRESS, UNPLAYED = 0, 1, 2

PLATFORM = "Askwho Casts"
EXTERNAL_ID_PREFIX = "askwhocasts:"
UNTITLED = "Askwho Casts episode"

COMPLETION_THRESHOLD_PERCENT = 95
COMPLETION_REMAINING_S = 120
COMPLETION_REMAINING_MIN_PERCENT = 80


@dataclass(frozen=True)
class Episode:
    guid: str | None
    title: str
    author: str | None
    play_state: int
    playhead: float
    duration: float | None


def percent(playhead: float, duration: float) -> int:
    """Listen percent, half-up like JS Math.round (Python's round() is banker's)."""
    return min(100, max(0, math.floor(playhead / duration * 100 + 0.5)))


def _status(pct: int, remaining_s: float) -> str | None:
    if pct >= COMPLETION_THRESHOLD_PERCENT:
        return "Completed"
    if (
        remaining_s <= COMPLETION_REMAINING_S
        and pct >= COMPLETION_REMAINING_MIN_PERCENT
    ):
        return "Completed"
    # Trivial progress (1% or less) isn't worth reporting, as in Spotify's sync.
    return "In Progress" if pct > 1 else None


def build_item(ep: Episode) -> dict | None:
    """Map one episode to a SyncItem, or None when there's nothing to report.

    Played covers both real playback and a manual "Mark as Played". Unplayed
    episodes are never sent, so a reset in Apple Podcasts can't downgrade an
    item (the server's high-water rule would ignore it anyway).
    """
    # The askwhocasts-sync cron stores the trimmed <guid>; match it exactly.
    guid = (ep.guid or "").strip()
    if not guid:
        return None
    if ep.play_state == PLAYED:
        progress, status = "100", "Completed"
    elif ep.play_state == IN_PROGRESS:
        if not ep.duration or ep.duration <= 0:
            return None
        playhead = ep.playhead or 0.0
        pct = percent(playhead, ep.duration)
        status = _status(pct, ep.duration - playhead)
        if status is None:
            return None
        progress = str(pct)
    else:
        return None
    return {
        # /api/sync rejects an empty title without reporting it as unmatched,
        # which would mark the episode delivered; matching is by ID, so a
        # placeholder label is harmless.
        "title": (ep.title or "").strip() or UNTITLED,
        "author": (ep.author or "").strip() or PLATFORM,
        "platform": PLATFORM,
        "externalId": f"{EXTERNAL_ID_PREFIX}{guid}",
        "progress": progress,
        "status": status,
    }


def _completeness(item: dict) -> tuple[bool, int]:
    return (item["status"] == "Completed", int(item["progress"]))


def build_items(episodes: Iterable[Episode]) -> list[dict]:
    """Map episodes, one item per externalId. The rotated feed's old podcast
    row can carry the same episode GUID, so keep the most complete copy
    (Completed first, then the higher percent) rather than sending both."""
    best: dict[str, dict] = {}
    for item in (build_item(ep) for ep in episodes):
        if item is None:
            continue
        current = best.get(item["externalId"])
        if current is None or _completeness(item) > _completeness(current):
            best[item["externalId"]] = item
    return list(best.values())
