"""Tests for the read-only Apple Podcasts DB reader (#322)."""

import pytest

from apple_podcasts_sync.build import IN_PROGRESS, PLAYED, Episode
from apple_podcasts_sync.reader import PodcastsDbError, read_episodes


def by_guid(episodes):
    return {e.guid: e for e in episodes}


def test_returns_played_and_in_progress_awc_episodes(podcasts_db):
    episodes = by_guid(read_episodes(podcasts_db))
    assert set(episodes) == {"played", "half", "oldfeed", "noenclosure"}
    assert episodes["played"] == Episode("played", "What is love?", "AI", PLAYED, 0.0, 232.0)
    assert episodes["half"] == Episode("half", "Roundup #89", "AI", IN_PROGRESS, 704.0, 1408.0)


def test_includes_the_pre_rotation_feed_host(podcasts_db):
    assert by_guid(read_episodes(podcasts_db))["oldfeed"].author is None


def test_missing_enclosure_yields_no_duration(podcasts_db):
    assert by_guid(read_episodes(podcasts_db))["noenclosure"].duration is None


def test_excludes_unplayed_other_shows_and_spoofed_hosts(podcasts_db):
    guids = set(by_guid(read_episodes(podcasts_db)))
    assert not guids & {"fresh", "duo", "spoof"}


def test_never_modifies_the_database(podcasts_db):
    before = podcasts_db.read_bytes()
    mtime = podcasts_db.stat().st_mtime_ns
    read_episodes(podcasts_db)
    assert podcasts_db.read_bytes() == before
    assert podcasts_db.stat().st_mtime_ns == mtime


def test_missing_database_raises(tmp_path):
    with pytest.raises(PodcastsDbError, match="Sync Library"):
        read_episodes(tmp_path / "nope.sqlite")


def test_unreadable_database_raises(tmp_path):
    bad = tmp_path / "MTLibrary.sqlite"
    bad.write_bytes(b"not a database at all" * 100)
    with pytest.raises(PodcastsDbError, match="unreadable"):
        read_episodes(bad)
