"""Tests for the changed-only delivery state (#322 review)."""

from apple_podcasts_sync.state import changed_items, load_state, next_state, save_state


def item(ext, progress="100", status="Completed"):
    return {"externalId": ext, "progress": progress, "status": status}


def test_first_run_sends_everything():
    items = [item("a"), item("b", "40", "In Progress")]
    assert changed_items(items, {}) == items


def test_unchanged_items_are_not_resent():
    # A played episode stays played forever; resending it would re-archive an
    # item the user restored to the queue.
    state = next_state({}, [item("a")], unmatched=[])
    assert changed_items([item("a")], state) == []


def test_a_progress_change_is_resent():
    state = next_state({}, [item("a", "40", "In Progress")], unmatched=[])
    assert changed_items([item("a")], state) == [item("a")]


def test_unmatched_items_are_retried_next_run():
    # Played before the askwhocasts cron attached its source row.
    state = next_state({}, [item("a"), item("b")], unmatched=["b"])
    assert changed_items([item("a"), item("b")], state) == [item("b")]


def test_next_state_keeps_entries_for_items_not_sent_this_run():
    state = next_state({}, [item("a")], unmatched=[])
    state = next_state(state, [item("b")], unmatched=[])
    assert changed_items([item("a"), item("b")], state) == []


def test_round_trip_and_missing_or_corrupt_file(tmp_path):
    path = tmp_path / "sub" / "state.json"
    assert load_state(path) == {}
    save_state(path, {"a": "Completed:100"})
    assert load_state(path) == {"a": "Completed:100"}
    path.write_text("{not json")
    assert load_state(path) == {}
