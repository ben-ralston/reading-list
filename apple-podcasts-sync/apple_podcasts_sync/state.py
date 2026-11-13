"""Changed-only delivery state for apple-podcasts-sync (#322).

A played episode stays played in Apple Podcasts forever. Resending it every
15 minutes would re-complete (and re-archive) an item the user deliberately
restored to the queue, and replay the whole history through the DB each run.
So each run sends only items whose (status, progress) differs from what was
last delivered. State is saved only after a run with no item errors, and
externalIds the server couldn't match yet (source not attached by the
askwhocasts cron) are dropped from state so they are retried.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

DEFAULT_STATE_PATH = Path.home() / ".local/state/reading-list/apple-podcasts-sync.json"


def _signature(item: dict) -> str:
    return f"{item['status']}:{item['progress']}"


def load_state(path: Path) -> dict[str, str]:
    """Last-delivered signatures by externalId; {} when missing or corrupt
    (which just means the next run resends everything — safe)."""
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save_state(path: Path, state: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(state, indent=0, sort_keys=True))
    os.replace(tmp, path)


def changed_items(items: list[dict], state: dict[str, str]) -> list[dict]:
    return [i for i in items if state.get(i["externalId"]) != _signature(i)]


def next_state(state: dict[str, str], sent: list[dict], unmatched: list[str]) -> dict[str, str]:
    result = dict(state)
    skip = set(unmatched)
    for item in sent:
        if item["externalId"] in skip:
            result.pop(item["externalId"], None)
        else:
            result[item["externalId"]] = _signature(item)
    return result
