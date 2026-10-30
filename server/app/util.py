"""Small helpers that several modules share."""
from __future__ import annotations

import re
import unicodedata
import uuid
from datetime import datetime, timezone

CONTROL = re.compile(r"[\x00-\x1f\x7f]")
# One half of a UTF-16 pair. JSON can name one with \ud800 to \udfff, but no UTF-8 text holds it, so the database cannot
# store it.
SURROGATE = re.compile(r"[\ud800-\udfff]")
# Characters that break a line or hide in a text: control characters (Cc), format characters such as a zero-width space
# or a right-to-left mark (Cf), the line and paragraph separators (Zl, Zp), and halves of UTF-16 pairs (Cs).
HIDDEN = frozenset({"Cc", "Cf", "Zl", "Zp", "Cs"})


def has_hidden(text: str) -> bool:
    return any(unicodedata.category(char) in HIDDEN for char in text)


def one_line(text: str) -> str:
    """The text on one line: every character of HIDDEN and every run of white space becomes one space."""
    return " ".join("".join(" " if unicodedata.category(char) in HIDDEN else char for char in text).split())


def iso(value: datetime | None) -> str | None:
    """A timestamp in UTC as 2026-10-18T22:00:00Z."""
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z") if value else None


def now_iso() -> str:
    return iso(datetime.now(timezone.utc))


def parse_uuid(text: str) -> str | None:
    try:
        return str(uuid.UUID(text))
    except (ValueError, TypeError, AttributeError):
        return None


def slugify(text: str, fallback: str = "map") -> str:
    """A slug from a title: German umlauts as ae, oe, ue and ss, other letters without accents."""
    text = text.lower()
    for umlaut, plain in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss")):
        text = text.replace(umlaut, plain)
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")[:60].strip("-")
    return text or fallback
