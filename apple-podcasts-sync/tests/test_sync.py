"""Tests for the apple-podcasts-sync entry point (#322)."""

import json
import subprocess

import pytest

from apple_podcasts_sync import sync
from apple_podcasts_sync.sync import chunk_items, ensure_podcasts_running, post_all


def test_chunk_items():
    assert [len(c) for c in chunk_items(list(range(120)), 50)] == [50, 50, 20]


def test_post_all_chunks_and_sums_counts():
    bodies = []

    def post(body):
        bodies.append(body)
        return {"processed": len(body["items"]), "updated": 1, "skipped": 2, "created": 0}

    summary = post_all([{"i": n} for n in range(120)], post=post, secret="s")
    assert [b["source"] for b in bodies] == ["apple_podcasts"] * 3
    assert all(b["secret"] == "s" for b in bodies)
    assert summary == {
        "chunks": 3,
        "processed": 120,
        "created": 0,
        "updated": 3,
        "skipped": 6,
        "errors": 0,
        "unmatched": [],
    }


def test_post_all_accumulates_item_errors_and_unmatched():
    responses = iter(
        [
            {"success": True, "errors": 0, "unmatched": ["askwhocasts:a"]},
            {"success": False, "errors": 2, "unmatched": ["askwhocasts:b"]},
        ]
    )
    summary = post_all([{"i": n} for n in range(60)], post=lambda b: next(responses), secret="s")
    assert summary["errors"] == 2
    assert summary["unmatched"] == ["askwhocasts:a", "askwhocasts:b"]


def test_post_all_counts_success_false_without_errors_as_a_failure():
    summary = post_all([{"i": 1}], post=lambda b: {"success": False}, secret="s")
    assert summary["errors"] >= 1


def test_post_all_reraises():
    def post(body):
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        post_all([{"i": 1}], post=post, secret="s")


class FakeRun:
    def __init__(self, pgrep_rc):
        self.pgrep_rc = pgrep_rc
        self.calls = []

    def __call__(self, cmd, **kwargs):
        self.calls.append(cmd)
        rc = self.pgrep_rc if cmd[0] == "pgrep" else 0
        return subprocess.CompletedProcess(cmd, rc)


def test_ensure_podcasts_running_leaves_a_running_app_alone():
    run = FakeRun(pgrep_rc=0)
    ensure_podcasts_running(run=run)
    assert run.calls == [["pgrep", "-x", "Podcasts"]]


def test_ensure_podcasts_running_launches_hidden_when_not_running():
    run = FakeRun(pgrep_rc=1)
    ensure_podcasts_running(run=run)
    assert run.calls[-1] == ["open", "-gj", "-a", "Podcasts"]


@pytest.fixture
def reports(monkeypatch):
    sent = []
    monkeypatch.setattr(sync, "report_failure", lambda msg, extra=None: sent.append((msg, extra)))
    return sent


@pytest.fixture
def no_launch(monkeypatch, tmp_path, reports):
    launched = []
    monkeypatch.setattr(sync, "ensure_podcasts_running", lambda: launched.append(True))
    monkeypatch.delenv("APPLE_PODCASTS_SYNC_URL", raising=False)
    monkeypatch.delenv("SYNC_API_SECRET", raising=False)
    monkeypatch.setenv("APPLE_PODCASTS_STATE", str(tmp_path / "state.json"))
    return launched


def test_dry_run_does_not_launch_podcasts(podcasts_db, monkeypatch, no_launch):
    monkeypatch.setenv("APPLE_PODCASTS_DB", str(podcasts_db))
    assert sync.main(["--dry-run"]) == 0
    assert no_launch == []


def test_missing_env_reports_failure_instead_of_crashing(podcasts_db, monkeypatch, capsys, no_launch, reports):
    monkeypatch.setenv("APPLE_PODCASTS_DB", str(podcasts_db))
    assert sync.main([]) == 1
    assert "FAILED" in capsys.readouterr().err
    assert reports and reports[0][0] == "apple-podcasts-sync failed"


def run_with_post(monkeypatch, podcasts_db, responder):
    """Run main() with a fake transport; returns the list of POSTed bodies."""
    bodies = []
    monkeypatch.setenv("APPLE_PODCASTS_DB", str(podcasts_db))
    monkeypatch.setenv("APPLE_PODCASTS_SYNC_URL", "http://localhost/api/sync")
    monkeypatch.setenv("SYNC_API_SECRET", "s")

    def make_post(client, url):
        def post(body):
            bodies.append(body)
            return responder(body)

        return post

    monkeypatch.setattr(sync, "_make_post", make_post)
    return bodies


def ok(body):
    return {"success": True, "processed": len(body["items"]), "errors": 0, "unmatched": []}


def test_second_run_sends_only_changes(podcasts_db, monkeypatch, no_launch):
    bodies = run_with_post(monkeypatch, podcasts_db, ok)
    assert sync.main([]) == 0
    assert sync.main([]) == 0
    assert len(bodies) == 1  # nothing changed → no POST on the second run


def test_item_errors_exit_nonzero_and_are_retried(podcasts_db, monkeypatch, capsys, no_launch, reports):
    bodies = run_with_post(
        monkeypatch, podcasts_db, lambda b: {"success": False, "errors": 1, "unmatched": []}
    )
    assert sync.main([]) == 1
    assert "FAILED" in capsys.readouterr().err
    assert reports
    assert sync.main([]) == 1
    assert len(bodies) == 2  # state not saved → everything resent


def test_unmatched_items_are_resent(podcasts_db, monkeypatch, no_launch):
    bodies = run_with_post(
        monkeypatch,
        podcasts_db,
        lambda b: {"success": True, "errors": 0, "unmatched": ["askwhocasts:half"]},
    )
    assert sync.main([]) == 0
    assert sync.main([]) == 0
    assert [i["externalId"] for i in bodies[1]["items"]] == ["askwhocasts:half"]


def test_non_json_response_reports_failure(podcasts_db, monkeypatch, capsys, no_launch, reports):
    def bad(body):
        raise ValueError("Expecting value")

    run_with_post(monkeypatch, podcasts_db, bad)
    assert sync.main([]) == 1
    assert "FAILED" in capsys.readouterr().err


def test_dry_run_prints_payload_without_posting(podcasts_db, monkeypatch, capsys, no_launch):
    monkeypatch.setenv("APPLE_PODCASTS_DB", str(podcasts_db))
    assert sync.main(["--dry-run"]) == 0
    out = capsys.readouterr().out
    payload = json.loads(out[out.index("[\n") :])
    assert {i["externalId"] for i in payload} == {
        "askwhocasts:played",
        "askwhocasts:half",
        "askwhocasts:oldfeed",
    }


def test_missing_database_exits_nonzero_without_posting(tmp_path, monkeypatch, capsys, no_launch, reports):
    monkeypatch.setenv("APPLE_PODCASTS_DB", str(tmp_path / "missing.sqlite"))
    assert sync.main([]) == 1
    assert "FAILED" in capsys.readouterr().err
    assert reports[0][0] == "apple-podcasts-sync failed"


def test_report_failure_is_a_no_op_without_a_configured_client(monkeypatch):
    # No LOGGER_CLIENT_DIR: nothing outside the repo is imported or touched.
    monkeypatch.delenv("LOGGER_CLIENT_DIR", raising=False)
    path_before = list(sync.sys.path)
    sync.report_failure("apple-podcasts-sync failed", {"reason": "x"})
    assert sync.sys.path == path_before


def test_report_failure_uses_the_configured_client(monkeypatch, tmp_path):
    out = tmp_path / "calls.txt"
    (tmp_path / "logger.py").write_text(
        "def log(app, level, message, json_extra=None, source=None):\n"
        f"    open({str(out)!r}, 'a').write(f'{{app}}|{{level}}|{{message}}|{{source}}|{{json_extra}}')\n"
    )
    monkeypatch.setenv("LOGGER_CLIENT_DIR", str(tmp_path))
    sync.report_failure("apple-podcasts-sync failed", {"reason": "x"})
    assert out.read_text() == "reading-list|error|apple-podcasts-sync failed|apple-podcasts-sync|{'reason': 'x'}"


def test_report_failure_swallows_a_missing_or_broken_client(monkeypatch, tmp_path):
    monkeypatch.setenv("LOGGER_CLIENT_DIR", str(tmp_path / "does-not-exist"))
    sync.report_failure("apple-podcasts-sync failed")  # must not raise
    (tmp_path / "logger.py").write_text("raise RuntimeError('boom')\n")
    monkeypatch.setenv("LOGGER_CLIENT_DIR", str(tmp_path))
    sync.report_failure("apple-podcasts-sync failed")  # must not raise
