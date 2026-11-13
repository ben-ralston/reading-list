"""Tests for the reader-feed pagination core (#192, mirrors audible-sync).

Only `_fetch_all_pages` and `_merge_candidates` carry logic; the httpx wrapper
(`fetch_reader_posts`) hits the real Substack API and is exercised in the
--dry-run verification step.

Pagination protocol (live-verified 2026-07-01): the reader feed ignores
`offset`/`page`; the working cursor is `after=<oldest inboxItems[].inbox_date
of the previous page>`. `get(cursor)` receives None for the first page and
returns (posts, publications, more, next_cursor).
"""

from substack_progress_sync.client import _auth_headers, _fetch_all_pages, _merge_candidates


def make_page(ids, more, next_cursor, pubs=()):
    posts = [{"id": i, "title": f"Post {i}"} for i in ids]
    publications = [{"id": p, "name": f"Pub {p}"} for p in pubs]
    return posts, publications, more, next_cursor


class TestFetchAllPages:
    def test_accumulates_pages_until_more_is_false(self):
        pages = {
            None: make_page([1, 2], True, "c1", pubs=[10]),
            "c1": make_page([3], False, "c2", pubs=[11]),
        }

        def get(cursor):
            return pages[cursor]

        posts, pubs = _fetch_all_pages(get, max_pages=5)

        assert [p["id"] for p in posts] == [1, 2, 3]
        assert set(pubs) == {10, 11}

    def test_threads_the_cursor_through_successive_gets(self):
        cursors = []

        def get(cursor):
            cursors.append(cursor)
            nxt = {None: "c1", "c1": "c2"}.get(cursor)
            return make_page([len(cursors)], nxt is not None, nxt)

        _fetch_all_pages(get, max_pages=10)

        assert cursors == [None, "c1", "c2"]

    def test_dedups_posts_and_publications_across_pages(self):
        pages = {
            None: make_page([1, 2], True, "c1", pubs=[10]),
            "c1": make_page([2, 3], False, None, pubs=[10]),
        }

        def get(cursor):
            return pages[cursor]

        posts, pubs = _fetch_all_pages(get, max_pages=5)

        assert [p["id"] for p in posts] == [1, 2, 3]
        assert list(pubs) == [10]

    def test_honors_max_pages_cap_and_logs_notice(self, capsys):
        def get(cursor):
            n = int(cursor or 0)
            return make_page([n + 1], True, str(n + 1))

        posts, _pubs = _fetch_all_pages(get, max_pages=3)

        assert len(posts) == 3
        assert "cap" in capsys.readouterr().out.lower()

    def test_stops_when_no_next_cursor_even_if_more_claims_true(self, capsys):
        calls = []

        def get(cursor):
            calls.append(cursor)
            return make_page([1], True, None)

        posts, _pubs = _fetch_all_pages(get, max_pages=5)

        assert [p["id"] for p in posts] == [1]
        assert calls == [None]
        # more=True with no cursor to advance is a visible partial harvest,
        # not a silent stop.
        assert "cursor" in capsys.readouterr().out.lower()

    def test_stops_when_the_cursor_does_not_advance(self):
        calls = []

        def get(cursor):
            calls.append(cursor)
            return make_page([len(calls)], True, "same")

        _fetch_all_pages(get, max_pages=5)

        assert calls == [None, "same"]


class TestMergeCandidates:
    def test_unwraps_nested_post_dicts_from_inbox_items(self):
        posts = [{"id": 1, "title": "A"}]
        inbox = [{"post": {"id": 2, "title": "B"}}]

        merged = _merge_candidates(posts, inbox)

        assert [p["id"] for p in merged] == [1, 2]

    def test_accepts_inbox_entries_that_are_post_shaped(self):
        merged = _merge_candidates([], [{"id": 3, "title": "C"}])
        assert [p["id"] for p in merged] == [3]

    def test_prefers_the_posts_entry_on_duplicate_ids(self):
        posts = [{"id": 1, "title": "from posts"}]
        inbox = [{"post": {"id": 1, "title": "from inbox"}}]

        merged = _merge_candidates(posts, inbox)

        assert merged == [{"id": 1, "title": "from posts"}]

    def test_ignores_state_row_inbox_entries_without_an_id(self):
        # Real inboxItems are per-user state rows (content_key, read_progress,
        # …) with no post id — they must be dropped, not crash the merge.
        merged = _merge_candidates(
            [], [{"content_key": "post:123", "max_read_progress": 0.5}]
        )
        assert merged == []


class TestAuthHeaders:
    def test_sends_sid_under_both_current_and_legacy_cookie_names(self):
        # Substack renamed the session cookie connect.sid -> substack.sid
        # (observed 2026-07-03). Sending the same value under both names works
        # regardless of which one the server's session middleware reads.
        headers = _auth_headers("s%3Aabc.def")

        cookies = dict(
            part.strip().split("=", 1) for part in headers["Cookie"].split(";")
        )
        assert cookies["substack.sid"] == "s%3Aabc.def"
        assert cookies["connect.sid"] == "s%3Aabc.def"
        assert headers["User-Agent"]
