"""Guard the committed launchd plist and TCC runner wiring (#322)."""

import plistlib
from pathlib import Path

LAUNCHD = Path(__file__).resolve().parent.parent / "launchd"
PLIST = LAUNCHD / "com.claude.apple-podcasts-sync.plist"
RUNNER_APP = "/Users/YOUR_USER/.claude/ApplePodcastsSync.app"


def _load():
    with PLIST.open("rb") as f:
        return plistlib.load(f)


def test_runs_every_15_minutes():
    plist = _load()
    assert plist["StartInterval"] == 900
    assert "StartCalendarInterval" not in plist


def test_logs_under_claude_logs():
    plist = _load()
    assert plist["Label"] == "com.claude.apple-podcasts-sync"
    assert plist["StandardOutPath"].endswith(".claude/logs/apple-podcasts-sync-stdout.log")
    assert plist["StandardErrorPath"].endswith(".claude/logs/apple-podcasts-sync-stderr.log")


def test_launchd_runs_the_signed_runner_app_not_bash():
    # TCC blocks a launchd bash from reading the Podcasts Group Container
    # ("unable to open database file"). Full Disk Access is granted to this
    # dedicated app only — never to /bin/bash.
    args = _load()["ProgramArguments"]
    assert args == [f"{RUNNER_APP}/Contents/MacOS/ApplePodcastsSyncRunner"]


def test_runner_execs_the_wrapper_script():
    swift = (LAUNCHD / "ApplePodcastsSyncRunner.swift").read_text()
    assert "apple-podcasts-sync/launchd/run-sync.sh" in swift


def test_build_script_targets_the_runner_app():
    build = (LAUNCHD / "build-runner.sh").read_text()
    assert ".claude/ApplePodcastsSync.app" in build
    assert "ApplePodcastsSyncRunner" in build
    assert "codesign" in build
