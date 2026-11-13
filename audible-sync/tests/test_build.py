"""Tests for the pure payload-building functions (#42).

These operate on already-fetched Audible library item dicts, so they need no
network or auth. The item field contract (asin, title, subtitle, authors[].name,
is_finished, percent_complete) comes from the Audible library API.
"""

from audible_sync.build import audible_external_id, build_items, map_status


class TestMapStatus:
    def test_finished_book_is_completed(self):
        assert map_status(is_finished=True, percent_complete=100.0) == "Completed"

    def test_finished_overrides_low_percent(self):
        # is_finished wins even if percent_complete is reported low.
        assert map_status(is_finished=True, percent_complete=0.0) == "Completed"

    def test_started_book_is_in_progress(self):
        assert map_status(is_finished=False, percent_complete=42.0) == "In Progress"

    def test_unstarted_zero_percent_has_no_status(self):
        assert map_status(is_finished=False, percent_complete=0.0) is None

    def test_unstarted_none_percent_has_no_status(self):
        assert map_status(is_finished=False, percent_complete=None) is None


class TestAudibleExternalId:
    def test_namespaced_format(self):
        assert audible_external_id("B07XYZ") == "audible:book:B07XYZ"


class TestBuildItems:
    def _one(self, items):
        out = build_items(items)
        assert len(out) == 1
        return out[0]

    def test_finished_book_maps_to_completed_payload(self):
        item = self._one(
            [
                {
                    "asin": "B07XYZ",
                    "title": "Atomic Habits",
                    "subtitle": "An Easy & Proven Way to Build Good Habits",
                    "authors": [{"name": "James Clear"}],
                    "is_finished": True,
                    "percent_complete": 100.0,
                }
            ]
        )
        assert item == {
            "title": "Atomic Habits",
            "author": "James Clear",
            "platform": "Audible",
            "kind": "book",
            "link": "https://www.audible.com/pd/B07XYZ",
            "externalId": "audible:book:B07XYZ",
            "progress": "100",
            "status": "Completed",
        }

    def test_in_progress_book(self):
        item = self._one(
            [
                {
                    "asin": "B01",
                    "title": "Deep Work",
                    "authors": [{"name": "Cal Newport"}],
                    "is_finished": False,
                    "percent_complete": 42.0,
                }
            ]
        )
        assert item["status"] == "In Progress"
        assert item["progress"] == "42"

    def test_unstarted_book_omits_status(self):
        item = self._one(
            [
                {
                    "asin": "B02",
                    "title": "Unread Book",
                    "authors": [{"name": "Some Author"}],
                    "is_finished": False,
                    "percent_complete": 0.0,
                }
            ]
        )
        assert "status" not in item
        assert item["progress"] == "0"

    def test_title_excludes_subtitle(self):
        item = self._one(
            [
                {
                    "asin": "B03",
                    "title": "Sapiens",
                    "subtitle": "A Brief History of Humankind",
                    "authors": [{"name": "Yuval Noah Harari"}],
                    "is_finished": True,
                    "percent_complete": 100.0,
                }
            ]
        )
        assert item["title"] == "Sapiens"

    def test_multiple_authors_uses_first(self):
        item = self._one(
            [
                {
                    "asin": "B04",
                    "title": "Good Omens",
                    "authors": [{"name": "Terry Pratchett"}, {"name": "Neil Gaiman"}],
                    "is_finished": False,
                    "percent_complete": 10.0,
                }
            ]
        )
        assert item["author"] == "Terry Pratchett"

    def test_percent_is_rounded(self):
        item = self._one(
            [
                {
                    "asin": "B05",
                    "title": "Rounding",
                    "authors": [{"name": "A"}],
                    "is_finished": False,
                    "percent_complete": 42.7,
                }
            ]
        )
        assert item["progress"] == "43"

    def test_skips_item_with_no_author(self):
        out = build_items(
            [
                {
                    "asin": "B06",
                    "title": "No Author",
                    "authors": [],
                    "is_finished": False,
                    "percent_complete": 5.0,
                }
            ]
        )
        assert out == []

    def test_skips_item_with_missing_asin(self):
        out = build_items(
            [
                {
                    "title": "No ASIN",
                    "authors": [{"name": "A"}],
                    "is_finished": False,
                    "percent_complete": 5.0,
                }
            ]
        )
        assert out == []

    def test_skips_item_with_empty_title(self):
        out = build_items(
            [
                {
                    "asin": "B07",
                    "title": "  ",
                    "authors": [{"name": "A"}],
                    "is_finished": False,
                    "percent_complete": 5.0,
                }
            ]
        )
        assert out == []

    def test_processes_each_valid_item_skips_invalid(self):
        out = build_items(
            [
                {
                    "asin": "B08",
                    "title": "Valid",
                    "authors": [{"name": "A"}],
                    "is_finished": True,
                    "percent_complete": 100.0,
                },
                {
                    "asin": "B09",
                    "title": "No author",
                    "authors": [],
                    "is_finished": False,
                },
            ]
        )
        assert [i["externalId"] for i in out] == ["audible:book:B08"]
