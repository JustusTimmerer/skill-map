# The interface texts

Every text of the interface lives in a catalog, one folder per language. English is the source language, and a first
visit shows English. German is the second language. The content of a map (its areas, categories, skills, stations,
projects and notes) is data. It stays in the language that its owner writes, and no catalog holds it.

`GLOSSARY.md` fixes the terms of the product in each language.

## The files

```
i18n/
  i18n.js          the function t and the language of the page (assets/i18n.js of the site)
  GLOSSARY.md      the terms of the product, per language
  en/              English, the source catalog
    page.json      the map page (skills/page.js, skills/editor_template.html)
    menu.json      the force menu (skills/forces.js and setupForces in skills/page.js)
    site.json      the start page, the embed view, the runtimes and the name and locale of the language
    account.json   the account page (server/app/static/)
    default.json   the names of the default set of a new map (selfhost/site/default-set.js, selfhost/FORMAT.md)
    server.json    the small pages that the server makes itself (server/app/pages.py)
  de/              German, with the same files
  tools/           the check (check.js), the batch translation (export.js, import.js) and the reader of the catalogs

server/app/i18n/   the catalogs of the server, in the same format, because the image of the server holds only server/
  en/
    errors.json    the texts of the error codes of the server (server/app/*.py). The pages show them too.
    mail.json      the mails of the server
    content.json   the texts that the server writes into a map
  de/              German, with the same files
```

A key is unique across both folders. The build writes the texts of `i18n/` and of `server/app/i18n/<language>/errors.json`
into `assets/i18n.js`. The mails and the content stay out of it. `server/README.md`, "The languages", describes the
server side: `server/app/texts.py`, its plural rules and the language of each mail.

An English entry has the text and a note for the translator:

```json
"share.title": { "text": "Share", "note": "Heading of the share dialog, one word." }
```

An entry of another language has the text and the English text that it translates (`source`). The check uses `source`
to find a translation whose English text changed later:

```json
"share.title": { "text": "Teilen", "source": "Share" }
```

## Keys

- A key names the meaning, not the words: `share.title`, `menu.ticks.label`, `time.reset`. It has two or more parts
  with a dot between them. Each part starts with a small letter and is camelCase. An error key keeps the code of the
  server: `error.not_found`.
- One key serves one text in one role. The heading "Projects" and the button "Projects" get two keys, because another
  language can need two words.
- Each call names its key as one literal string: `t("time.reset")`. So a search finds every use, and the check finds
  every key. The force menu is the only exception: the text fields of `SPEC` in `skills/forces.js` hold the keys
  `menu.<key of the setting>.label`, `.tip` and `.hint`, and the groups `menu.group.<name>.title` and `.note`.

## Texts

- A placeholder has a name: `{count}`, `{name}`, `{mb}`. The code passes the values: `t("search.hits", { count: 3, query })`.
- A text with a plural is an object with the forms of `Intl.PluralRules` of its language, and `count` picks the form.
  English and German need `one` and `other`. `other` is always there. A text with a plural in English has a plural
  in every language, and the other way round. A word that stays the same, as in „1 Treffer“ and „2 Treffer“, still
  gets both forms. A limit that the host sets, such as `{max}` maps, also needs a plural, because the host can set it
  to 1. The code then passes `count` beside `max`.

  ```json
  "overview.skills": { "text": { "one": "{count} skill", "other": "{count} skills" }, "note": "…" }
  ```

- A text holds no `<`, `>`, `&` and no straight double quote, so a text is safe in HTML and in an attribute. Write
  “…” in English and „…“ in German. `t` never escapes: code that puts a value into HTML escapes the value first, as
  before.
- Numbers and dates of the interface go through `SkillMapI18n.number()` and `SkillMapI18n.date()`, which use
  `Intl.NumberFormat` and `Intl.DateTimeFormat` with the locale of the language (`language.locale`: `en-GB`, `de-DE`).
  The sort order of map content stays German (`localeCompare(…, "de")`), because the layout depends on it.

## The page

`build_selfhost.js` writes every catalog, without notes and sources, `i18n/i18n.js` and the dropdown of the languages
(`selfhost/site/language.js`) into `assets/i18n.js`. Every page of the site loads it as its first script: the map
pages, the start page, the legal pages and the account page of the server.

- The language: the first of these sources that names a language of the build. The embed view takes the parameter
  `lang` of its address first, because a frame on another site has no storage of its own; the code of the share
  dialog names it. Then comes the language of the signed-in account, the field `language` of the data block of the
  server, then the choice that this browser keeps in `localStorage` under `skill-map-language`, then English. A
  language of the account becomes the choice of this browser too, so that the static pages follow the account. The
  page sets `<html lang>` to it, and `SkillMapI18n.source` names its source. `SkillMapI18n.choose(code)` keeps a
  choice for the next load, and `SkillMapI18n.languages()` lists the languages of the build.
- A static page of the server (the legal pages, `example.html` and `map.html`) has no data block, and stage a has no
  API. So a choice there cannot reach the account at once, and the static page asks the API nothing. Instead the
  browser keeps under `skill-map-language-account` what the last page of the app said: `signed-in` for a signed-in
  account, and no entry without one. A choice on a page without the session turns `signed-in` into `newer`. The next
  page of the app with a signed-in account then shows that choice instead of the language of the account
  (`SkillMapI18n.newer`). On its load, the dropdown sends the choice to the account with `PATCH /api/account`, and the
  entry is `signed-in` again. A page of the app without a session removes the entry. So a choice without an account
  never changes an account that signs in later.
- The dropdown fills each element with `data-language-picker`: every language in its own name. A choice keeps the
  language at once. For a signed-in user it first sends `PATCH /api/account`, and if the server refuses, the page keeps
  its language and shows the error next to the dropdown. The page does not load again by itself, so a half-filled form
  stays. A note next to the dropdown says to reload the page, with a button that reloads it. The note is in the chosen
  language (`SkillMapI18n.textIn`). The embed view and a page in a frame have no dropdown.
- An element with `data-versions` shows the child whose `lang` is the language of the page, else its English child.
  The legal pages hold their German and English text this way, because a legal text is no text of the catalogs.
- `t(key, values)` gives the text in the language of the page, and `SkillMapI18n.textIn(code, key, values)` the text
  in another language of the build. A key that the language lacks takes the English text and logs a warning. A key
  that English lacks gives the key itself and logs an error, and so does a missing value. The browser tests fail on
  every console error.
- Static markup names its keys in attributes, and `assets/i18n.js` fills them, so no page needs an inline script.
- The PDF download draws its text in the embedded font Noto Sans, which covers Latin, Greek and Cyrillic. Its foot line
  holds the text `download.foot.range`. For a language in another script, the page warns before each PDF and names the
  characters that the font cannot draw (`selfhost/FORMAT.md`).
  `data-i18n="<key>"` sets the text of an element. An element that holds other elements keeps them: the text replaces
  only its first text node with words. `data-i18n-attr="title:<key>; aria-label:<key>"` sets attributes. The markup
  holds the English text, so a page without scripts reads in English. Markup that a script adds later uses `t`, or it
  calls `SkillMapI18n.apply(element)`.

## The errors of the server

The server answers an error with `{"error": "<code>", "message": "<text>", "params": {…}}`. The page, the runtimes
and the account page show `SkillMapI18n.errorText(body)`: the text of `error.<code>` with the values of `params`.

- A code with several texts names its text in `params.variant`, and the catalog has `error.<code>.<variant>`.
- If the catalog has no text for the code, or `params` lacks a value that the text needs, the page shows
  `message` of the server.
- The check counts `error.<code>` and `error.<code>.<variant>` as used for each code and variant of the server, because
  the page builds these keys from the answer. The server names each code and variant as literal strings, as in
  `ApiError(409, "handle_taken")` and `bad("weak_password", "short", min=12)`, and its texts as `text(language, "<key>")`.
  So the check finds each key, and it fails on an error whose code is no literal string.

## The tests

Every existing suite runs in German: `openPage` of `tests/e2e/site.js` and the contexts of `tests/selfhost/run.js`,
`tests/server/run.js` and `tests/release/run.js` store `de` before a page loads. So each check keeps its name and its
expectation, and a pass proves that the German texts did not change. Pass `language: null` for a page in English.

The suite of the site also opens every kind of page in a pseudo language (`PSEUDO` of `build_selfhost.js`): a test
build adds the language `qps`, whose texts are the English texts between `⟦` and `⟧`. The run fails on each visible
text and on each `title`, `aria-label`, `placeholder` and `alt` with a word outside the marks, and on a missing key. Map
data, numbers, the legal text and names that no language translates do not count. The build of the site never has
the pseudo language.

`npm run check:texts` (`i18n/tools/check.js`) fails when:

1. the code uses a key that English lacks,
2. nothing uses a key of English,
3. another language has a key that English lacks, or holds it in another file,
4. the placeholders of a key differ between English and another language,
5. the pages (`i18n/`) and the server (`server/app/i18n/`) have other languages,
6. a text of English has plural forms and its translation has none, or the other way round.

It also lists each key that another language lacks, and each key whose `source` differs from the English text of
today. Those are warnings, because a translation can follow later. With `--complete`, they fail too. A merge into
`main` needs `npm run check:texts -- --complete`. `npm test` and `tests/e2e/all.js` run the check.

## A new text

1. Write the English entry with its note, in the file of its part, next to the keys of the same place.
2. Use the key in the code with `t("<key>")` or in the markup with `data-i18n`.
3. Run `npm run check:texts`. The other languages now lack the key, which is a warning.
4. A later batch translates it (below). Do not translate at the spot.

If you change an English text, the check names its translations as stale until a batch translates them again.

## A batch translation

1. `node i18n/tools/export.js de` writes every missing or stale key of German into one file,
   `i18n/batches/de-<date>.json` (git ignores the folder). Each entry has the English text, the note, the files that
   use the key, the old German text of a stale key and an empty `text`.
2. A translator fills `text` of each entry, with the terms of `GLOSSARY.md`. A text with a plural takes the forms of its
   language. The placeholders stay as they are.
3. `node i18n/tools/import.js i18n/batches/de-<date>.json` merges the filled entries into `i18n/de/` and sets `source`
   to the English text of the export. It skips an empty entry, an entry with other placeholders than English, and an
   entry whose English text changed since the export. It also skips a text without plural forms whose English text
   has them, and the other way round. It names each one.
4. Run `npm run check:texts`, and commit the catalogs.

## A new language

1. Make the folders `i18n/<code>/` and `server/app/i18n/<code>/`, for example `i18n/fr/` and `server/app/i18n/fr/`.
   `node i18n/tools/export.js fr` lists every key of both, and `import.js` puts each one into the file of its English
   key. Add the plural rule of the language to `PLURALS` in `server/app/texts.py`, or the server does not start.
2. Translate `language.name` (the name of the language in itself) and `language.locale` (a BCP 47 locale, for
   example `fr-FR`) first, then the rest.
3. Add a column to `GLOSSARY.md`.
4. The build takes every folder of `i18n/`, so the language is in the list of every page.
