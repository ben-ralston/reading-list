"""Tests for the library pagination loop (#42).

`_fetch_all` is decoupled from the real Audible client (it takes a `get(page)`
callable) so pagination is testable without network or auth.
"""

from audible_sync.client import _fetch_all


def test_single_short_page_stops_immediately():
    pages = {1: [{"asin": "A"}, {"asin": "B"}]}
    calls = []

    def get(page):
        calls.append(page)
        return pages.get(page, [])

    items = _fetch_all(get, page_size=50)

    assert calls == [1]
    assert [i["asin"] for i in items] == ["A", "B"]


def test_paginates_until_a_short_page():
    pages = {1: [1, 2], 2: [3, 4], 3: [5]}
    calls = []

    def get(page):
        calls.append(page)
        return pages.get(page, [])

    items = _fetch_all(get, page_size=2)

    assert calls == [1, 2, 3]
    assert items == [1, 2, 3, 4, 5]


def test_full_last_page_then_empty_page():
    # When the final real page is exactly page_size, the loop must request one
    # more page and stop on the empty result.
    pages = {1: [1, 2], 2: [3, 4]}
    calls = []

    def get(page):
        calls.append(page)
        return pages.get(page, [])

    items = _fetch_all(get, page_size=2)

    assert calls == [1, 2, 3]
    assert items == [1, 2, 3, 4]
