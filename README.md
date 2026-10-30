# Skill-Map

Skill-Map shows the skills of a person as a network. It sorts skills into areas and categories. It shows at which stations (employers, education, private projects) and in which projects the person used each skill. Readers zoom in, filter by station, project and time range, and download the map as SVG, PNG or PDF.

The site runs in the browser. A map lives in the browser of its owner, and the map file is its safe copy. An optional server adds accounts, shared maps and teams.

## What is in this repository

- `selfhost/site/`, `selfhost/runtime/` and `skills/`: the static site and the editor. The owner of a map edits areas, categories, skills, stations and projects. A force menu sets the layout.
- `build_selfhost.js`: builds the site into `dist/selfhost/`.
- `make_upload.js`: builds one folder for an upload to a web space, with an `.htaccess` for Apache.
- `llms.txt`, `selfhost/site/ai/`: a description of the map file for AI tools, so that a tool can make a map from a CV.
- `server/`: the optional server, a Docker Compose stack with Caddy, a FastAPI app and PostgreSQL.
- `i18n/`: the interface texts in English and German.
- `tests/`: browser tests with Playwright. `server/tests/`: the tests of the server.

The example map of this repository is made up. Its people, employers and projects do not exist.

## Build and run the static site

You need Node 24. The build needs no npm package.

```
node build_selfhost.js
npm run serve:selfhost
```

Then open `http://127.0.0.1:8080/`. `selfhost/DEPLOY.md` tells how to put the site on a web space, with its cache rules and security headers.

To make one folder for an upload:

```
node make_upload.js ../skill-map-upload --site https://example.org
```

`--legal legal.json` fills the imprint and the privacy notice. `selfhost/site/legal.example.json` shows the fields.

## Tests

```
npm install
npm test
```

`npm test` builds the site, checks the interface texts and runs the browser suites that need no server. `server/README.md` tells how to run the server and its tests.

## The map file

`selfhost/FORMAT.md` describes the map file. `selfhost/site/ai/format.txt` describes it for AI tools.

## License

Copyright (c) 2026 Justus Timmerer.

The code is under the [PolyForm Noncommercial License 1.0.0](LICENSE). You can use, change and share it for noncommercial purposes. Commercial use needs a license from the author. To ask for one, contact [JustusTimmerer on GitHub](https://github.com/JustusTimmerer).

The libraries and fonts in `selfhost/vendor/` keep their own licenses, in `selfhost/vendor/licenses/`.
