"""Audible auth + library fetch (#42).

Thin wrappers over the `mkb79/audible` library. Only the pagination loop
(`_fetch_all`) carries logic and is unit-tested; `load_auth` / `fetch_library`
hit the real Audible API and are exercised in the human bootstrap + e2e step.

`is_finished` and `percent_complete` are requested as response groups so each
library item carries its listening status. (Token refresh happens in-memory; we
never write auth.json back, so it can be loaded from an ephemeral/CI file.)
"""

from __future__ import annotations

from collections.abc import Callable

import audible

# Audible /1.0/library response groups. `is_finished` and `percent_complete` are
# themselves response groups — without them, items carry no listening status.
LIBRARY_RESPONSE_GROUPS = (
    "contributors, product_desc, product_attrs, is_finished, percent_complete"
)

# Audible caps a single library page at 1000 results.
PAGE_SIZE = 1000


def load_auth(path: str) -> "audible.Authenticator":
    """Load saved Audible credentials from an auth.json file."""
    return audible.Authenticator.from_file(path)


def _fetch_all(get: Callable[[int], list], *, page_size: int) -> list:
    """Accumulate every page. `get(page)` returns that page's items.

    Stops on the first page shorter than `page_size` (the last page), requesting
    one extra empty page only when the final real page is exactly full.
    """
    items: list = []
    page = 1
    while True:
        batch = get(page)
        items.extend(batch)
        if len(batch) < page_size:
            return items
        page += 1


def fetch_library(
    auth: "audible.Authenticator", *, page_size: int = PAGE_SIZE
) -> list[dict]:
    """Fetch the full Audible library with listening status, paginating."""
    with audible.Client(auth=auth) as client:

        def get(page: int) -> list:
            resp = client.get(
                "1.0/library",
                num_results=page_size,
                page=page,
                response_groups=LIBRARY_RESPONSE_GROUPS,
            )
            return resp.get("items", []) or []

        return _fetch_all(get, page_size=page_size)
