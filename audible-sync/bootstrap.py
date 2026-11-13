"""One-time interactive Audible auth bootstrap (#42).

Run this LOCALLY, by a human — it cannot be automated, because Audible login
requires real 2FA/CAPTCHA. It opens the Amazon login in your browser (where 2FA
is handled natively), you paste the post-login redirect URL back, and it writes
an `auth.json` device-credential file.

Usage:
    uv run python bootstrap.py            # writes ./auth.json

Then base64-encode auth.json into the AUDIBLE_AUTH_B64 GitHub secret — see
README.md. The durable credentials in auth.json (refresh token + device key) are
long-lived; you only need to re-run this if you change your Amazon password or
deregister the device.
"""

from __future__ import annotations

import sys

# Importing readline makes input() accept arbitrarily long pasted lines on
# macOS. Without it, the post-login redirect URL (well over 1024 chars) is
# silently truncated and never parses — the prompt just hangs. The library's
# own instructions call this out. Best-effort: not present on some platforms.
try:
    import readline  # noqa: F401
except ImportError:
    pass

import audible

LOCALE = "us"  # US Audible marketplace. Change for .de / .co.uk / etc.
OUT_PATH = "auth.json"


def main() -> int:
    print(
        "Opening Audible's external login flow.\n"
        "A login URL will be printed — open it in your browser, sign in "
        "(completing 2FA), and paste the final redirect URL back here.\n"
    )
    # Browser-based login: Amazon handles 2FA/CAPTCHA, the library captures the
    # post-login redirect and registers a device. Most robust for 2FA accounts.
    auth = audible.Authenticator.from_login_external(locale=LOCALE)
    auth.to_file(OUT_PATH)
    print(
        f"\nWrote {OUT_PATH}. Next: base64-encode it into AUDIBLE_AUTH_B64 (see README)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
