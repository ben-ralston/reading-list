"""Tests for the reader-post → /api/sync payload mapping (#192)."""

from substack_progress_sync.build import build_items, map_status, substack_external_id


PUBLICATIONS = {
    89120: {"id": 89120, "name": "Astral Codex Ten", "subdomain": "astralcodexten"},
    295937: {"id": 295937, "name": "Freddie deBoer", "subdomain": "freddiedeboer"},
}


def make_post(**overrides):
    post = {
        "id": 196778898,
        "title": "Chip Off The Old Block",
        "slug": "chip-off-the-old-block",
        "canonical_url": "https://www.astralcodexten.com/p/chip-off-the-old-block",
        "publication_id": 89120,
        "read_progress": 0.55,
        "max_read_progress": 0.63,
        "publishedBylines": [{"name": "Scott Alexander"}],
    }
    post.update(overrides)
    return post


class TestSubstackExternalId:
    def test_namespaced_and_byte_stable(self):
        assert substack_external_id(196778898) == "substack:post:196778898"


class TestMapStatus:
    def test_97_and_above_is_completed(self):
        assert map_status(97) == "Completed"
        assert map_status(100) == "Completed"

    def test_middle_band_is_in_progress(self):
        assert map_status(2) == "In Progress"
        assert map_status(63) == "In Progress"
        assert map_status(96) == "In Progress"

    def test_1_and_below_is_none(self):
        assert map_status(1) is None
        assert map_status(0) is None


class TestBuildItems:
    def test_maps_a_started_post_with_publication_name_author(self):
        items = build_items([make_post()], PUBLICATIONS)

        assert items == [
            {
                "title": "Chip Off The Old Block",
                "author": "Astral Codex Ten",
                "platform": "Substack",
                "link": "https://www.astralcodexten.com/p/chip-off-the-old-block",
                "externalId": "substack:post:196778898",
                "progress": "63",
                "status": "In Progress",
            }
        ]

    def test_uses_max_read_progress_not_read_progress(self):
        items = build_items(
            [make_post(read_progress=0.1, max_read_progress=0.8)], PUBLICATIONS
        )
        assert items[0]["progress"] == "80"

    def test_fully_read_post_is_completed(self):
        items = build_items([make_post(max_read_progress=1.0)], PUBLICATIONS)
        assert items[0]["progress"] == "100"
        assert items[0]["status"] == "Completed"

    def test_drops_unstarted_and_barely_started_posts(self):
        posts = [
            make_post(id=1, max_read_progress=0),
            make_post(id=2, max_read_progress=0.01),
            make_post(id=3, max_read_progress=None),
        ]
        assert build_items(posts, PUBLICATIONS) == []

    def test_drops_posts_missing_title_or_id(self):
        posts = [
            make_post(title=""),
            make_post(title=None),
            make_post(id=None),
        ]
        assert build_items(posts, PUBLICATIONS) == []

    def test_byline_fallback_when_publication_unknown(self):
        items = build_items([make_post(publication_id=999999)], PUBLICATIONS)
        assert items[0]["author"] == "Scott Alexander"

    def test_drops_post_with_no_resolvable_author(self):
        post = make_post(publication_id=999999, publishedBylines=[])
        assert build_items([post], PUBLICATIONS) == []

    def test_rounds_half_up_at_the_completed_threshold(self):
        # Python round() is banker's rounding (round(96.5) == 96), which would
        # let 0.965 dodge the >=97 Completed threshold.
        items = build_items([make_post(max_read_progress=0.965)], PUBLICATIONS)
        assert items[0]["progress"] == "97"
        assert items[0]["status"] == "Completed"

    def test_clamps_progress_above_100(self):
        items = build_items([make_post(max_read_progress=1.2)], PUBLICATIONS)
        assert items[0]["progress"] == "100"

    def test_omits_link_when_canonical_url_missing(self):
        items = build_items([make_post(canonical_url="")], PUBLICATIONS)
        assert len(items) == 1
        assert "link" not in items[0]
