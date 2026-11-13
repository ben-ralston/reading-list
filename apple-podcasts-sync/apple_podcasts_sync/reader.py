"""Read Askwho Casts play state from Apple Podcasts' local database (#322).

Apple has no API for podcast listen state; the only source is the Podcasts
app's Core Data store, which mirrors the iPhone library when Podcasts on the
Mac has Settings → General → Sync Library enabled. The database is opened
read-only (`mode=ro`, which still reads the WAL) — this job never writes it.
"""

from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path
from urllib.parse import urlparse

from apple_podcasts_sync.build import Episode

DEFAULT_DB_PATH = (
    Path.home()
    / "Library/Group Containers/243LU875E5.groups.com.apple.podcasts/Documents/MTLibrary.sqlite"
)

# The private AWC feed. The pre-rotation feed's podcast row (app. host)
# persists in the library, so both hosts count.
AWC_HOSTS = {"askwhocasts.com", "app.askwhocasts.com"}

# Only played (0) and in-progress (1) episodes; unplayed (2) is never synced.
QUERY = """
SELECT e.ZGUID, e.ZTITLE, e.ZAUTHOR, e.ZPLAYSTATE, e.ZPLAYHEAD, m.ZDURATION, p.ZFEEDURL
FROM ZMTEPISODE e
JOIN ZMTPODCAST p ON p.Z_PK = e.ZPODCAST
LEFT JOIN ZMTMEDIAENCLOSURE m ON m.Z_PK = e.ZCURRENTMEDIAENCLOSURE
WHERE e.ZPLAYSTATE IN (0, 1)
"""


class PodcastsDbError(Exception):
    """The Podcasts database is missing or unreadable."""


def read_episodes(db_path: Path = DEFAULT_DB_PATH) -> list[Episode]:
    if not db_path.is_file():
        raise PodcastsDbError(
            f"Apple Podcasts DB not found at {db_path} — "
            "enable Sync Library in Podcasts on this Mac"
        )
    uri = f"{db_path.resolve().as_uri()}?mode=ro"
    try:
        with closing(sqlite3.connect(uri, uri=True, timeout=10)) as conn:
            rows = conn.execute(QUERY).fetchall()
    except sqlite3.Error as e:
        raise PodcastsDbError(f"Apple Podcasts DB unreadable: {e}") from e
    # Host filtering in Python (not SQL LIKE) so a feed URL merely containing
    # "askwhocasts.com" in its path can't pass.
    return [
        Episode(guid, title or "", author, state, playhead or 0.0, duration)
        for guid, title, author, state, playhead, duration, feed_url in rows
        if urlparse(feed_url or "").hostname in AWC_HOSTS
    ]
