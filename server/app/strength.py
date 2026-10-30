"""The strength of a password: zxcvbn with its English lists and the German lists in zxcvbn-de/.

The score runs from 0 to 4, and the server takes a password with STRONG. zxcvbn rates the first SCORED characters
only, because its search grows fast with the length; the rest of a longer password only adds to its strength. The
warnings and tips are ids of texts of the account page (account.strength.*), so that the meter shows them in the
language of the page."""
from __future__ import annotations

import json
import threading
from pathlib import Path

from zxcvbn import zxcvbn
from zxcvbn.matching import add_frequency_lists
from zxcvbn.scoring import ALL_UPPER, START_UPPER

STRONG = 4
SCORED = 72
MIN_DIFFERENT = 4
SITE_WORDS = ("it-skills", "itskills", "it-skills.net", "skill-map", "skillmap", "skills", "skill")

_GERMAN = Path(__file__).parent / "zxcvbn-de"
add_frequency_lists({f"german_{name}": json.loads((_GERMAN / f"{name}.json").read_text(encoding="utf-8"))
                     for name in ("commonWords", "firstnames", "lastnames")})
# zxcvbn keeps the personal words of a call in a dictionary of its module, so two calls at once would mix them.
_LOCK = threading.Lock()

_WORDS = {"english_wikipedia", "us_tv_and_film", "german_commonWords"}
_NAMES = {"surnames", "male_names", "female_names", "german_firstnames", "german_lastnames"}


def rate(password: str, personal: list[str]) -> dict:
    """{score, warning, tips}: the score from 0 to 4, the id of one warning or None, and the ids of the tips."""
    if len(set(password.lower())) < MIN_DIFFERENT:
        return {"score": 0, "warning": "repeat", "tips": ["moreWords"]}
    with _LOCK:
        result = zxcvbn(password[:SCORED], user_inputs=[*personal, *SITE_WORDS])
    if result["score"] >= STRONG:
        return {"score": result["score"], "warning": None, "tips": []}
    sequence = result["sequence"]
    longest = max(sequence, key=lambda match: len(match["token"]))
    warning, tips = _feedback(longest, len(sequence) == 1)
    return {"score": result["score"], "warning": warning, "tips": ["moreWords", *tips]}


def _feedback(match: dict, sole: bool) -> tuple[str | None, list[str]]:
    # The rules of zxcvbn.feedback, for the longest part of the password, with the German lists and the personal words.
    pattern = match["pattern"]
    if pattern == "dictionary":
        return _word_feedback(match, sole)
    if pattern == "spatial":
        return "keyboard", []
    if pattern == "repeat":
        return "repeat", []
    if pattern == "sequence":
        return "sequence", []
    if pattern == "date" or (pattern == "regex" and match.get("regex_name") == "recent_year"):
        return "dates", []
    return None, []


def _word_feedback(match: dict, sole: bool) -> tuple[str | None, list[str]]:
    name, token = match["dictionary_name"], match["token"]
    warning = None
    if name == "passwords":
        if sole and not match.get("l33t") and not match["reversed"]:
            warning = "common"
        elif match["guesses_log10"] <= 4:
            warning = "similar"
    elif name == "user_inputs":
        warning = "personal"
    elif name in _WORDS and sole:
        warning = "word"
    elif name in _NAMES:
        warning = "names"
    tips = []
    if START_UPPER.search(token) or (ALL_UPPER.search(token) and token.lower() != token):
        tips.append("capitals")
    if match["reversed"] and len(token) >= 4:
        tips.append("reversed")
    if match.get("l33t"):
        tips.append("substitutions")
    return warning, tips
