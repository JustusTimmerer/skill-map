# The map file

One JSON file holds one map. The self-hosted site exports it with "Export" and reads it with "Open map file". Stage b (accounts) stores the same documents for each map and exports and imports the same file.

The file name is `<title>.it-skills-map.json`. The site replaces each character that a file system does not allow with "-".

The example map of the site is a file of this format: `selfhost/site/example.it-skills-map.json`. `node save_example.js` makes it from his data in `skills/`, and the site build reads it for `example.html`. A new map starts from the default set or empty (see "The default set" below).

## Top level

```json
{
  "format": "it-skills-map",
  "schema": 1,
  "title": "Meine Skills",
  "exportedAt": "2026-10-18T22:00:00Z",
  "collections": {
    "areas": { "sd": { "name": "Softwareentwicklung", "color": "#2c5fc4", "at": [20, -107], "order": 0 } }
  }
}
```

| Field | Type | Rule |
|---|---|---|
| `format` | text | Always `"it-skills-map"`. A reader refuses every other value. |
| `schema` | whole number | The version of the format, 1 for now. `1.0` is the same number as `1`. A reader migrates an older file step by step and refuses a newer one. |
| `title` | text | The title of the map, at most 120 characters. A reader makes each run of white space one space and removes the spaces at both ends. Then it keeps the first 120 characters of a longer title. It refuses a title with a control character or with one half of a UTF-16 pair. A file without a title, or with an empty one, gets "Imported map", or "Importierte Map" in German. |
| `exportedAt` | text | The time of the export in UTC, as ISO 8601 with "Z". A reader does not need it. |
| `collections` | object | One entry for each collection: `{ "<document id>": { document fields } }`. |

## Names and ids

- A collection name matches `^[a-z][a-z0-9_-]{0,40}$`.
- A document id has 1 to 200 characters, no "/", no control character and no half of a UTF-16 pair.
- The ids ".", ".." and `__proto__` are not allowed. A browser removes "." and ".." from the address of a write, so the page can never change such a document. `__proto__` is a special name in JavaScript.
- Three collections have a stricter rule, because the page writes these ids into class names and attributes:
  - `areas`: `^[a-z][a-z0-9_-]{0,39}$`.
  - `stations`: `^[A-Za-z][A-Za-z0-9_-]{0,39}$`. The id must not end in a small "i", because `places` marks an indirect use with a trailing "i". The id `PRIVAT` is not allowed, because projects use it for private projects.
  - `groups`: `^[a-z0-9][a-z0-9_-]{0,119}$`.
- Each document is a JSON object. Its values nest 64 levels deep at most, and the document itself is level 0.
- No string of a document holds a null character or half of a UTF-16 pair, and no number is infinite, for example `1e999`. The rule holds for the keys too.
- A file can hold other collections with a valid name. The site keeps them and exports them again, but does not show them.
- The site and the server apply the same rules to a file and to each write: `validId` and `parseFile` in `selfhost/runtime/local.js`, and `check_doc_id` and `parse_map_file` in `server/app/store.py`. So a file that one of them takes, the other takes too.

## The collections

The page reads each field with a fallback, so a missing or wrong field does not break the map. When the page saves a document, it writes the fields of this list only. In the tables, "order" is the sort key that keeps the layout stable.

### `areas`: the areas of the map

| Field | Type | Meaning |
|---|---|---|
| `name` | text | The name, for example "Softwareentwicklung". An area without a name is not shown. |
| `color` | text | The color as `#rrggbb`. The dark theme mixes it with white. Fallback: `#596763`. |
| `at` | [x, y] | The start point of the area in the layout, two numbers. Fallback: a point on a ring. A configuration can set its own start points (`values.at`). |
| `order` | number | The order of the areas. |

### `stations`: employers, education and private projects

| Field | Type | Meaning |
|---|---|---|
| `name` | text | The full name, for example "Musterfirma GmbH". A station without a name is not shown. |
| `short` | text | The short name for the note of a standard skill. Empty means the full name. |
| `kind` | text | "Arbeitgeber", "Ausbildung" or "Privates Projekt". The page lists private projects apart. |
| `when` | text | The period, for example `03.2013 – 10.2019`, `2005 – 2010`, `seit 05.2026` or `since 05.2026`. `MM.YYYY` and `MM/YYYY` are a month, and `YYYY` is a whole year. A period with "seit", "since", "heute", "today" or "present" runs to today, in every language. Empty means no date. The forms of the page take one date or two dates with a dash. They also take "seit" or "since" before a date, or a dash and "heute", "today" or "present" after it. They refuse every other word. |
| `months` | number | The months in active use, 0 or more. They fill the experience ring and weigh the place. |
| `note` | text | One line about the station. |
| `order` | number | Breaks ties. The page sorts the stations by the start of `when`. A station without a date comes last. |

### `groups`: the categories

| Field | Type | Meaning |
|---|---|---|
| `name` | text | The name, for example "Sprachen". |
| `area` | text | The id of its area. A category of a missing area is not shown. |
| `order` | number | The order of the categories. |

### `skills`: the skills

| Field | Type | Meaning |
|---|---|---|
| `name` | text | The name. It is unique in the map, and projects use it. |
| `group` | text | The id of its category. |
| `rating` | number | 3 sehr gut, 2 gut, 1 Grundkenntnisse, 0 not rated yet, -1 used with AI without own routine. |
| `places` | list of text | The station ids where the skill was used. An id with a trailing "i" is an indirect use. |
| `order` | number | The order of the skills. |
| `standard` | object, optional | `{ "text": "...", "since": "<station id>" }`. A standard skill counts for every station from `since` on, while the switch "Standard skills" is on. |

### `projects`: the projects of each station

| Field | Type | Meaning |
|---|---|---|
| `name` | text | The name of the project. |
| `station` | text | The station id, or `PRIVAT` for a private project. |
| `base` | true or false | A base stack: the skills of the whole station, without lines. |
| `order` | whole number | The number of the project in its station, 0 or more. |
| `when` | text | The period of the project, in the form of `stations.when`. Empty means the period of its station. |
| `skills` | list of text | The names of its skills. |

### `configs`: saved configurations of the force menu

| Field | Type | Meaning |
|---|---|---|
| `name` | text | The name that the owner gave it. |
| `schema` | whole number | The version of `values`: `SPRING_SCHEMA` in `skills/forces.js`, 4 for now. It has its own migration steps. |
| `values` | object | The values of the force menu: one entry for each key of `SPEC` in `skills/forces.js`, the line values of each line mode under `lines`, and the start points under `at`. |
| `savedAt` | text | The time of the save, ISO 8601. |

### `settings`: the documents `reader` and `texts`

The document `reader` names the configuration for readers.

| Field | Type | Meaning |
|---|---|---|
| `config` | text | The id of the configuration that readers see. The map also starts with it. |
| `pickedAt` | text | The time of the pick, ISO 8601. |

The document `texts` holds texts of the map. It is optional.

| Field | Type | Meaning |
|---|---|---|
| `privateNote` | text, optional | A note below the heading "Private projects" in the overview. Without it, the page shows no note. |

## Names in a PDF download

A name and the title can hold any character. The SVG and the PNG draw them with the fonts of the browser. The PDF embeds the font Noto Sans 2.015 of the site, in `vendor/fonts/` with the SIL Open Font License 1.1. It draws Latin with its accents, Greek and Cyrillic. `build_selfhost.js` records the source and the SHA-256 of each font file, and the page checks the hash when it loads the font.

Before a PDF, the page checks the names and the title against the characters of the font. Some characters are outside the font, for example Chinese, Japanese or an emoji. Then the page names these characters first, and the visitor can still download the PDF. The PDF shows "�" (U+FFFD) in place of each such character.

## The default set

A new map starts from "Default set" or "Empty": on the start page, in the account card of the start page, and in the two forms of the account page of the server, for a personal map and for a team map. The default set has three areas with two categories each and two skills in each category, and no stations or projects.

`selfhost/site/default-set.js` holds its structure in the shape of a map file, without words: `title`, `empty` and `collections` with the collections `areas`, `groups` and `skills`. Each field of a document is the field of this format. Each name is the key of its text in `i18n/<language>/default.json`, written as `t("<key>")`, so that `npm run check:texts` finds every key:

```js
areas: { software: { name: t("default.area.software"), color: "#2c5fc4", at: [-150, -70], order: 0 } }
```

| Field | Meaning |
|---|---|
| `title` | The key of the title of a new map from the default set. |
| `empty` | The key of the title of a new empty map. |
| `collections.areas` | The areas with `name`, `color`, `at` (the start point) and `order`. |
| `collections.groups` | The categories with `name`, `area` and `order`. |
| `collections.skills` | The skills with `name`, `group`, `rating` (1, as the skill form gives a new skill), `places` (empty) and `order`. |

The site build reads the file with a `t` that gives the key itself. It checks that English has each key and that the map passes the rules of an import in every language. Then it writes the structure with its keys into `assets/templates.js`. When a visitor makes a new map, `SkillMapTemplates.map(kind)` gives the title and each name in the language of the page at that moment. So the names of a map are data from then on, in the language that the owner saw.

## Migration

A file with an older `schema` goes through the steps in `MIGRATIONS` in `selfhost/runtime/local.js`, one step for each version. Step n turns schema n into schema n + 1. Schema 1 is the first version, so the list is empty.

A new schema needs these changes:

1. Raise `SCHEMA` in `selfhost/runtime/local.js`.
2. Add its step to `MIGRATIONS`.
3. Describe the change here.
