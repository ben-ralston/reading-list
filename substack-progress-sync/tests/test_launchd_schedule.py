"""The launchd job must run hourly (#222), not once daily.

Substack read-progress sync moved to launchd on the Mac (#195); #222 tightens
the cadence from daily to every 60 minutes. This guards the committed plist so
the interval isn't silently lost if the job is reinstalled.
"""

import plistlib
from pathlib import Path

PLIST = (
    Path(__file__).resolve().parent.parent
    / "launchd"
    / "com.claude.substack-progress-sync.plist"
)


def _load():
    with PLIST.open("rb") as f:
        return plistlib.load(f)


def test_plist_fires_hourly():
    plist = _load()

    interval = plist.get("StartInterval")
    calendar = plist.get("StartCalendarInterval")

    # Exactly one scheduling mechanism should be present.
    assert (interval is None) != (calendar is None), (
        "plist must use exactly one of StartInterval / StartCalendarInterval"
    )

    if interval is not None:
        # StartInterval is in seconds; hourly == 3600.
        assert interval == 3600, f"expected 3600s interval, got {interval}"
        return

    # StartCalendarInterval with no Hour key is a wildcard hour -> fires every
    # hour. An Hour key would pin it to once per day, which is the daily cadence
    # #222 removes.
    assert "Hour" not in calendar, (
        "StartCalendarInterval has an Hour key, so it fires only once daily; "
        "remove Hour so it fires hourly"
    )
    assert "Minute" in calendar, "expected a fixed Minute for the hourly fire"
