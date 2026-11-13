"""Tests for the chunked-POST accumulation core (#42).

`post_all` is injected with a `post` callable so the HTTP/auth layers stay out of
these tests — they cover chunking, payload shape, count accumulation, and error
propagation only.
"""

import pytest

from audible_sync.sync import chunk_items, post_all


def make_items(n):
    return [
        {
            "title": f"Book {i}",
            "author": "A",
            "platform": "Audible",
            "kind": "book",
            "link": f"https://www.audible.com/pd/B{i}",
            "externalId": f"audible:book:B{i}",
            "progress": "0",
        }
        for i in range(n)
    ]


class TestChunkItems:
    def test_splits_into_fixed_size_batches(self):
        batches = list(chunk_items(make_items(120), 50))
        assert [len(b) for b in batches] == [50, 50, 20]

    def test_empty_yields_nothing(self):
        assert list(chunk_items([], 50)) == []


class TestPostAll:
    def test_posts_each_chunk(self):
        calls = []

        def fake_post(payload):
            calls.append(payload)
            return {
                "processed": len(payload["items"]),
                "created": 1,
                "updated": 2,
                "skipped": 0,
            }

        post_all(make_items(120), post=fake_post, secret="s3cr3t", chunk_size=50)

        assert len(calls) == 3
        assert [len(c["items"]) for c in calls] == [50, 50, 20]

    def test_payload_shape(self):
        captured = {}

        def fake_post(payload):
            captured.update(payload)
            return {}

        post_all(make_items(1), post=fake_post, secret="s3cr3t")

        assert captured["source"] == "audible"
        assert captured["secret"] == "s3cr3t"
        assert captured["items"][0]["kind"] == "book"

    def test_accumulates_counts_across_chunks(self):
        def fake_post(payload):
            return {
                "processed": len(payload["items"]),
                "created": 1,
                "updated": 2,
                "skipped": 3,
            }

        summary = post_all(make_items(120), post=fake_post, secret="s", chunk_size=50)

        assert summary["chunks"] == 3
        assert summary["created"] == 3  # 1 per chunk
        assert summary["updated"] == 6  # 2 per chunk
        assert summary["skipped"] == 9  # 3 per chunk
        assert summary["processed"] == 120

    def test_no_items_posts_nothing(self):
        calls = []

        def fake_post(payload):
            calls.append(payload)
            return {}

        summary = post_all([], post=fake_post, secret="s")

        assert calls == []
        assert summary == {
            "chunks": 0,
            "processed": 0,
            "created": 0,
            "updated": 0,
            "skipped": 0,
        }

    def test_propagates_post_error(self):
        def fake_post(payload):
            raise RuntimeError("HTTP 500")

        with pytest.raises(RuntimeError):
            post_all(make_items(1), post=fake_post, secret="s")
