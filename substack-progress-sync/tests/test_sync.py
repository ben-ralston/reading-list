"""Tests for the chunked-POST accumulation core (#192, mirrors audible-sync).

`post_all` is injected with a `post` callable so the HTTP/auth layers stay out
of these tests — they cover chunking, payload shape, count accumulation, and
error propagation only.
"""

import pytest

from substack_progress_sync.sync import CHUNK_SIZE, SOURCE, chunk_items, post_all


def make_items(n):
    return [
        {
            "title": f"Post {i}",
            "author": "Some Publication",
            "platform": "Substack",
            "link": f"https://pub.substack.com/p/post-{i}",
            "externalId": f"substack:post:{i}",
            "progress": "50",
            "status": "In Progress",
        }
        for i in range(n)
    ]


class TestChunkItems:
    def test_splits_into_fixed_size_batches(self):
        batches = list(chunk_items(make_items(120), 50))
        assert [len(b) for b in batches] == [50, 50, 20]

    def test_empty_list_yields_nothing(self):
        assert list(chunk_items([], 50)) == []


class TestPostAll:
    def test_posts_source_substack_with_secret(self):
        payloads = []

        def post(payload):
            payloads.append(payload)
            return {"processed": len(payload["items"]), "created": 0, "updated": 0, "skipped": 0}

        post_all(make_items(3), post=post, secret="s3cret")

        assert len(payloads) == 1
        assert payloads[0]["source"] == "substack"
        assert payloads[0]["secret"] == "s3cret"
        assert len(payloads[0]["items"]) == 3

    def test_chunks_and_accumulates_counts(self):
        def post(payload):
            n = len(payload["items"])
            return {"processed": n, "created": 0, "updated": n - 1, "skipped": 1}

        summary = post_all(make_items(120), post=post, secret="s")

        assert summary == {
            "chunks": 3,
            "processed": 120,
            "created": 0,
            "updated": 117,
            "skipped": 3,
        }

    def test_propagates_post_errors(self):
        def post(_payload):
            raise RuntimeError("boom")

        with pytest.raises(RuntimeError, match="boom"):
            post_all(make_items(1), post=post, secret="s")


def test_source_and_chunk_size_constants():
    assert SOURCE == "substack"
    assert CHUNK_SIZE == 50
