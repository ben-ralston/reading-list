"""Fixture MTLibrary.sqlite with the real Apple Podcasts table/column names (#322)."""

import sqlite3

import pytest

AWC_FEED = "https://askwhocasts.com/f/feedtoken/f"
OLD_AWC_FEED = "http://app.askwhocasts.com/f/oldtoken"


def make_podcasts_db(path, episodes, podcasts=None):
    """Create a minimal MTLibrary.sqlite. `episodes` rows:
    (podcast_pk, guid, title, author, play_state, playhead, duration_or_None)."""
    podcasts = podcasts or [
        (1, "Askwho Casts Pro", AWC_FEED),
        (2, None, OLD_AWC_FEED),
        (3, "Duolingo French Podcast", "https://frpodcast.libsyn.com/rss"),
        (4, "Impostor", "https://evil.example/askwhocasts.com/f"),
    ]
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE ZMTPODCAST (Z_PK INTEGER PRIMARY KEY, ZTITLE VARCHAR, ZFEEDURL VARCHAR);
        CREATE TABLE ZMTMEDIAENCLOSURE (Z_PK INTEGER PRIMARY KEY, ZDURATION FLOAT);
        CREATE TABLE ZMTEPISODE (
          Z_PK INTEGER PRIMARY KEY, ZPODCAST INTEGER, ZCURRENTMEDIAENCLOSURE INTEGER,
          ZGUID VARCHAR, ZTITLE VARCHAR, ZAUTHOR VARCHAR,
          ZPLAYSTATE INTEGER, ZPLAYHEAD FLOAT
        );
        """
    )
    conn.executemany("INSERT INTO ZMTPODCAST VALUES (?, ?, ?)", podcasts)
    for pk, (podcast, guid, title, author, state, playhead, duration) in enumerate(episodes, 1):
        enclosure = None
        if duration is not None:
            conn.execute("INSERT INTO ZMTMEDIAENCLOSURE VALUES (?, ?)", (pk, duration))
            enclosure = pk
        conn.execute(
            "INSERT INTO ZMTEPISODE VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (pk, podcast, enclosure, guid, title, author, state, playhead),
        )
    conn.commit()
    conn.close()
    return path


DEFAULT_EPISODES = [
    (1, "played", "What is love?", "AI", 0, 0.0, 232.0),
    (1, "half", "Roundup #89", "AI", 1, 704.0, 1408.0),
    (1, "fresh", "Four eras", "AI", 2, 0.0, 2299.0),
    (2, "oldfeed", "Old feed episode", None, 0, 0.0, 900.0),
    (1, "noenclosure", "No enclosure", "AI", 1, 30.0, None),
    (3, "duo", "Duolingo", "Duolingo", 0, 0.0, 600.0),
    (4, "spoof", "Impostor", "x", 0, 0.0, 600.0),
]


@pytest.fixture
def podcasts_db(tmp_path):
    return make_podcasts_db(tmp_path / "MTLibrary.sqlite", DEFAULT_EPISODES)
