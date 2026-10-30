"""The texts of the server in each language: the catalogs in server/app/i18n/<language>/*.json.

The catalogs have the format of the catalogs of the pages (i18n/README.md): an English entry is {"text", "note"}, an
entry of another language {"text", "source"}. A text is a string with placeholders such as {handle}, or an object of
plural forms such as {"one": ..., "other": ...}, and the value count picks the form. The files:

- errors.json: the text of each error code (errors.py). The pages show them too: the build of the site writes them into
  assets/i18n.js.
- mail.json: the subjects and texts of the mails (mail.py).
- content.json: the texts that the server writes into a map, such as the title of an imported map without a title.

The languages of the server are the folders of server/app/i18n/. The module reads every catalog once, when it loads.
npm run check:texts checks the catalogs: every key that the code uses is in English, the placeholders agree, and the
server has the languages of the pages."""
from __future__ import annotations

import json
import re
from pathlib import Path

FOLDER = Path(__file__).parent / "i18n"
SOURCE = "en"
PLACEHOLDER = re.compile(r"\{(\w+)\}")

# The plural rule of each language of the server: the form of a text with a plural for a count. The pages take the
# rules of Intl.PluralRules, which know every language. The server knows only the languages of this table. English and
# German need the forms "one" and "other". A new language adds its rule here, or the server does not start.
PLURALS = {
    "en": lambda count: "one" if count == 1 else "other",
    "de": lambda count: "one" if count == 1 else "other",
}


def load(folder: Path = FOLDER) -> dict[str, dict]:
    """{language: {key: text}} of every catalog of the folder. English must be there, and each language needs a rule
    in PLURALS."""
    catalogs: dict[str, dict] = {}
    for directory in sorted(path for path in folder.iterdir() if path.is_dir()):
        entries: dict = {}
        for file in sorted(directory.glob("*.json")):
            for key, entry in json.loads(file.read_text(encoding="utf-8")).items():
                entries[key] = entry["text"]
        catalogs[directory.name] = entries
    if SOURCE not in catalogs:
        raise RuntimeError(f"{folder}/{SOURCE} is missing: English is the source catalog")
    missing = sorted(set(catalogs) - set(PLURALS))
    if missing:
        raise RuntimeError(f"no plural rule for {', '.join(missing)}: add one to PLURALS in {Path(__file__).name}")
    return catalogs


CATALOGS = load()
# The languages of the server, English first.
LANGUAGES = tuple(sorted(CATALOGS, key=lambda code: (code != SOURCE, code)))


def known(language) -> bool:
    return isinstance(language, str) and language in CATALOGS


def text(language: str | None, key: str, **values) -> str:
    """The text of key in language, with each {name} replaced by values[name]. A language without a catalog, and a key
    that the language lacks, take English. A key that English lacks and a missing value raise a KeyError, so that a test
    finds them. A text with a plural takes the form of values["count"]."""
    code = language if known(language) else SOURCE
    found = CATALOGS[code].get(key)
    if found is None:
        code, found = SOURCE, CATALOGS[SOURCE].get(key)
    if found is None:
        raise KeyError(f"no text {key} in {FOLDER.name}/{SOURCE}")
    if isinstance(found, dict):
        if "count" not in values:
            raise KeyError(f"the text {key} has a plural and needs the value count")
        found = found.get(PLURALS[code](values["count"]), found["other"])

    def fill(match: re.Match) -> str:
        if match[1] not in values:
            raise KeyError(f"the text {key} needs the value {match[1]}")
        return str(values[match[1]])

    return PLACEHOLDER.sub(fill, found)
