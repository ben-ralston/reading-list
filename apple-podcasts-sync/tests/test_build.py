"""Tests for the Apple Podcasts episode → /api/sync payload mapping (#322)."""

from apple_podcasts_sync.build import (
    IN_PROGRESS,
    PLAYED,
    UNPLAYED,
    Episode,
    build_item,
    build_items,
    percent,
)


def ep(**overrides):
    base = dict(
        guid="g1",
        title="What is love?",
        author="Askwho Casts AI",
        play_state=IN_PROGRESS,
        playhead=0.0,
        duration=1000.0,
    )
    base.update(overrides)
    return Episode(**base)


def test_played_is_completed_100():
    assert build_item(ep(play_state=PLAYED)) == {
        "title": "What is love?",
        "author": "Askwho Casts AI",
        "platform": "Askwho Casts",
        "externalId": "askwhocasts:g1",
        "progress": "100",
        "status": "Completed",
    }


def test_unplayed_is_never_sent():
    # An episode reset to unplayed must never downgrade a Completed item.
    assert build_item(ep(play_state=UNPLAYED, playhead=500)) is None


def test_in_progress_reports_percent():
    item = build_item(ep(playhead=250))
    assert (item["progress"], item["status"]) == ("25", "In Progress")


def test_half_percent_rounds_up_like_js_math_round():
    assert percent(25, 1000) == 3  # Python's round(2.5) would give 2
    assert percent(945, 1000) == 95


def test_95_percent_completes():
    assert build_item(ep(playhead=945))["status"] == "Completed"


def test_near_end_rule_mirrors_spotify():
    # 120 s left at 88% → Completed (stopped before the outro).
    assert build_item(ep(playhead=880, duration=1000))["status"] == "Completed"
    # 100 s left but only 50% through a short episode → still In Progress.
    assert build_item(ep(playhead=100, duration=200))["status"] == "In Progress"


def test_trivial_progress_is_dropped():
    assert build_item(ep(playhead=10)) is None  # 1%


def test_missing_duration_or_guid_is_dropped():
    assert build_item(ep(playhead=10, duration=None)) is None
    assert build_item(ep(playhead=10, duration=0)) is None
    assert build_item(ep(guid=None, play_state=PLAYED)) is None
    assert build_item(ep(guid="", play_state=PLAYED)) is None


def test_played_without_duration_still_completes():
    assert build_item(ep(play_state=PLAYED, duration=None))["status"] == "Completed"


def test_author_falls_back_to_platform():
    # /api/sync rejects an empty author.
    assert build_item(ep(play_state=PLAYED, author=None))["author"] == "Askwho Casts"
    assert build_item(ep(play_state=PLAYED, author="  "))["author"] == "Askwho Casts"


def test_build_items_filters_unsyncable():
    items = build_items(
        [ep(guid="a", play_state=PLAYED), ep(guid="b", play_state=UNPLAYED)]
    )
    assert [i["externalId"] for i in items] == ["askwhocasts:a"]


def test_guid_is_trimmed_like_the_askwhocasts_cron():
    item = build_item(ep(guid="  abc123\n", play_state=PLAYED))
    assert item["externalId"] == "askwhocasts:abc123"


def test_whitespace_only_guid_is_dropped():
    assert build_item(ep(guid="  ", play_state=PLAYED)) is None


def test_duplicate_guids_keep_the_most_complete_copy():
    # The rotated feed's old podcast row can hold the same episode.
    items = build_items(
        [
            ep(guid="x", playhead=300),  # 30% In Progress
            ep(guid="x", play_state=PLAYED),  # Completed
            ep(guid="y", playhead=200),
            ep(guid="y", playhead=600),
        ]
    )
    assert [(i["externalId"], i["progress"]) for i in items] == [
        ("askwhocasts:x", "100"),
        ("askwhocasts:y", "60"),
    ]


def test_empty_title_gets_a_placeholder_so_the_route_accepts_it():
    # /api/sync drops items with an empty title without listing them as
    # unmatched, so the harvester would record them as delivered. Matching is
    # by externalId only, so the title is just a label.
    assert build_item(ep(title="", play_state=PLAYED))["title"] == "Askwho Casts episode"
    assert build_item(ep(title="   ", play_state=PLAYED))["title"] == "Askwho Casts episode"
