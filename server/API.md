# API of the server

All endpoints are below `/api` on the main domain. A request body and a response body are JSON, unless the text names another type.

## Rules for every request

- Writes: every `POST`, `PUT`, `PATCH` and `DELETE` must send the header `X-Requested-With: it-skills` and an `Origin` header equal to `BASE_URL`. A browser adds `Origin` itself. Without them, the answer is `403` with the error `csrf`.
- Session: the cookie `__Host-session` (or `session` with `APP_ENV=local`) carries the session. `POST /api/auth/login` sets it. A session ends `SESSION_DAYS` (30) after the sign-in at the latest, and `SESSION_IDLE_DAYS` (7) after its last use. The cookie ends at the first end, so its `Max-Age` is the time that is left until then. No later answer sets the cookie again.
- Errors: an error body is `{"error": "<code>", "message": "<English text>", "params": {...}}`. The code is stable. `params` holds every value that the text of the code needs, for example `{"min": 12}`, and it is `{}` for a text without values. A code with several texts names its text in `params.variant`, for example `{"variant": "short", "min": 12}`. `message` is the English text with the values filled in. A page shows the text of the code in its own language: the key `error.<code>.<variant>` or `error.<code>` of the catalogs (`server/app/i18n/<language>/errors.json`, `i18n/README.md`).
- Body size: a document write can send 512 KB at most, an import 8 MB, every other request 64 KB. A larger body gets `413` with `body_too_large`.
- Not found: an unknown path, a map of another user, a private map and an invalid id all get `404` with `not_found`. The server does not tell whether such a map exists.
- Roles (stage c): a member of a team reads every map of the team. A member who lacks the role for an action gets `403` with `forbidden`. A visitor without a role gets `404` for every action that is no read, also on a public map. `README.md` lists the roles.
- Every API answer has `Cache-Control: no-store`.
- Every answer has `X-Content-Type-Options: nosniff`, a `Referrer-Policy` and a Content-Security-Policy (see "Embed views and framing"). An answer that the app gives before a route also has them, for example `403 csrf` and `413 body_too_large`.
- A path with "/" at the end: the API answers `404 not_found`. A page gets `308` to the address without the "/" (see "Pages"). No answer leads to `http://` or to another host.
- An error that the server did not expect gets `500` with `internal`, as JSON for an API request and as a page for a page. The server writes the error to its log, and the connection stays open for the next request.

A limit per IP counts an IPv6 client by its /64 network, because one host often owns a whole /64.

Errors that every endpoint can give are not repeated below: `403 csrf`, `413 body_too_large`, `404 not_found` and `405 method_not_allowed` (the path exists, but not for this method). The same holds for `422 invalid_request`: the JSON does not fit the request, and the answer has a list `fields` beside `params`. Every endpoint that names a role can also give `403 forbidden`.

The variants of the codes with several texts:

| Code | Variants and values |
|---|---|
| `weak_password` | `short` with `min`, `long` with `max`, `personal`, `guessable` |
| `invalid_token` | `register`, `reset`, `invitation` |
| `wrong_password` | `confirm` (the password of a registration), `current` (the password of the signed-in account) |
| `last_owner` | `account` with `teams` (the handles of the teams, joined with ", "), `member` |
| `conflict` | no variant: a document changed after `base`. `moved`: another request moved the map to another owner during the change. |
| `too_many_teams` | no variant, with `max` and `count`: the user of the request leads `max` teams already. `member` with `max` and `count`: the member who gets the role owner leads `max` teams already. |
| `invalid_document` | `notObject`, `tooDeep`, `nullCharacter`, `notUtf8`, `notFinite` |
| `invalid_map_file` | `notObject`, `schema`, `noCollections`, `collection` with `name` |
| `invalid_id` | `areas`, `stations` with `code` (the reserved station id `PRIVAT`), `groups`: the stricter rule of that collection. Without a variant, the id breaks the rule of every collection. |

The codes `too_many_origins` and `invalid_title` have the value `max`. `too_many_maps` and `too_many_teams` have `max` and `count`, both the largest number. `count` picks the plural form of the text, because the host can set the number to 1. The values of the other codes: `document_too_large` has `kb`, `map_too_large` has `mb`, `wrong_format` has `format`, `invalid_origin` has `origin`. `bad_language` has `languages`: the codes of the languages of the server joined with ", ".

The answer of a success can have a `message` too, in English. A page shows its own text for the `status` of the answer.

## Languages

Each account has a language: `en` or `de`, the folders of `server/app/i18n/`. It is the language of the mails to the account and of its pages. A registration names it, `PATCH /api/account` changes it, and without one an account gets `en`. An unknown language gets `400 bad_language`. `README.md`, "The languages", tells which mail takes which language.

## Accounts

### POST /api/auth/register

Request: `{"email": "anna@example.org", "password": "...", "handle": "anna", "language": "de"}`. `language` is optional: without it, the account gets `en`.

Response `202`: `{"status": "check_mail", "message": "..."}`. The server sends the confirmation mail, in the language of the registration. If the address already has an account, the answer is the same. Then the mail tells the owner of the address about the attempt, in the language of the account.

Errors:

| Status | Code | Reason |
|---|---|---|
| 400 | `invalid_email` | The address is not valid: it needs a local part, "@" and a domain with a dot, and it may not hold white space, a control character or one of `, ; < > ( ) [ ]`, the backslash or the double quote, which split or quote an address in a mail header. |
| 400 | `invalid_handle` | The handle breaks the rules: 3 to 30 characters, a to z, 0 to 9 and "-", no "-" at the start or end, no "--". |
| 400 | `reserved_handle` | The handle is on the reserved list (`RESERVED` in `app/security.py`). The list holds every top-level name of the site and of the app, such as `api`, `account`, `assets`, `vendor`, `example` and `index`. The reason: `<BASE_URL>/<handle>` shares the top-level paths with them. |
| 400 | `weak_password` | Fewer than 12 or more than 1024 characters (`short`, `long`), equal to the e-mail address or the handle (`personal`), or easy to guess (`guessable`): fewer than 4 different characters, or a score below 4 in the strength check. `POST /api/auth/password-check` gives the same verdict before the registration. |
| 400 | `bad_language` | The server has no catalog of the language. |
| 409 | `handle_taken` | Another account or a team has the handle, or another owner freed it less than `HANDLE_HOLD_DAYS` ago (`README.md`). Both get the same answer. |
| 429 | `rate_limited` | Too many registrations from this IP (`RATE_LIMIT_REGISTER_IP`), or too many registrations of this address that sent a mail (`RATE_LIMIT_REGISTER_ACCOUNT`). A known and a new address get the same answers. The header `Retry-After` gives the seconds. |

A registration that nobody confirms within 7 days goes at the next registration or new team, and its handle is free at once. A second registration with the same address replaces a registration that nobody confirmed: its handle, its password and its language. The links of earlier mails stop working. Then only the person who sent the newest registration knows the password, and only the owner of the address has the link. So nobody can confirm it, and the address stays free for its owner, who registers again.

### POST /api/auth/confirm

Request: `{"token": "<token from the mail>", "password": "<password of the registration>"}`. The mail links to `/account#confirm=<token>`. The account page asks for the password and sends both. Only someone who holds both the mailbox and the password of a registration can confirm it.

Response `200`: `{"status": "confirmed", "message": "..."}`

Errors:

| Status | Code | Reason |
|---|---|---|
| 400 | `invalid_token` | The token is unknown, used, or older than 48 hours. |
| 401 | `wrong_password` | The password is not the password of the registration. The link stays valid. |
| 429 | `rate_limited` | Too many attempts from this IP (`RATE_LIMIT_LOGIN_IP`). |

### POST /api/auth/login

Request: `{"email": "...", "password": "..."}`

Response `200`: `{"handle": "anna", "email": "anna@example.org", "language": "de"}` with a new session cookie. The session that the browser sent with the login ends.

Errors:

| Status | Code | Reason |
|---|---|---|
| 401 | `invalid_credentials` | Wrong password or unknown address. Both get the same answer. |
| 403 | `not_confirmed` | The password is right, but nobody confirmed the account yet. |
| 429 | `rate_limited` | Too many logins from this IP or for this address. |

### POST /api/auth/logout

No request body. Response `204`. The session ends and the cookie is cleared.

### GET /api/auth/session

Response `200`: `{"signedIn": false}` or `{"signedIn": true, "handle": "anna", "email": "anna@example.org", "language": "de"}`. This endpoint never answers 401, so that a page can ask without an error.

### POST /api/auth/reset-request

Request: `{"email": "..."}`

Response `202`: `{"status": "check_mail", "message": "..."}`, for every address. If the account exists and is confirmed, the server sends a mail with a link to `/account#reset=<token>`. If the account is not confirmed yet, it sends the confirmation mail again. Each mail has the language of the account.

Errors: `429 rate_limited` (per IP and per address).

### POST /api/auth/reset

Request: `{"token": "<token from the mail>", "password": "<new password>"}`

Response `200`: `{"status": "password_changed", "message": "..."}`. Every session of the user ends.

Errors: `400 invalid_token` (unknown, used, or older than one hour), `400 weak_password` (the link stays valid), `429 rate_limited`.

### POST /api/auth/password-check

The rule of a new password, applied to this one, for the strength meter of the account page. It stores nothing and needs no session.

Request: `{"password": "...", "email": "...", "handle": "..."}`. `email` and `handle` are optional. The server counts them as known words of the user. Without both, it takes those of the signed-in user.

Response `200`:

```json
{"ok": false, "problem": "guessable", "score": 1, "warning": "keyboard", "tips": ["moreWords"], "min": 12, "max": 1024}
```

| Field | Meaning |
|---|---|
| `ok` | `true` if a registration, a reset or a change takes this password |
| `problem` | `null`, or the variant of `weak_password` that a registration would give |
| `score` | The score of the strength check, 0 to 4. The server takes 4. |
| `warning` | `null` or one of `common`, `similar`, `word`, `names`, `personal`, `keyboard`, `repeat`, `sequence`, `dates` |
| `tips` | Each of `moreWords`, `capitals`, `substitutions`, `reversed`. Empty for score 4. |
| `min`, `max` | The least and the largest number of characters |

The account page shows each warning and tip with its text `account.strength.warn.<id>` or `account.strength.tip.<id>`.

Errors: `429 rate_limited` (`RATE_LIMIT_PASSWORD_CHECK_IP`).

### GET /api/account

Needs a session. Response `200`:

```json
{"handle": "anna", "email": "anna@example.org", "language": "de", "created": "2026-10-18T22:00:00Z", "maps": 2,
 "teams": 1, "profileUrl": "https://it-skills.net/anna", "siteUrl": "https://anna.it-skills.net"}
```

`maps` counts the personal maps, `teams` the teams of the user. `profileUrl` is the address of the user, `<BASE_URL>/<handle>`: the start map of the user, or the list of the public maps (see "Pages"). `siteUrl` is the same page on the subdomain, or `null` without `BASE_DOMAIN`. Errors: `401 not_logged_in`.

### PATCH /api/account

Needs a session. Request: `{"language": "de"}`. Response `200`: the account, as `GET /api/account` gives it. A body without `language` changes nothing.

Errors: `401 not_logged_in`, `400 bad_language`.

### POST /api/account/password

Needs a session. Request: `{"current": "...", "new": "..."}`

Response `200`: `{"status": "password_changed", "message": "..."}` with a new session cookie. Every other session ends.

Errors: `401 not_logged_in`, `401 wrong_password`, `400 weak_password`, `429 rate_limited`.

### POST /api/account/delete

Needs a session. Request: `{"password": "..."}`

Response `204`. The server deletes the account, its sessions, its memberships, its maps, their documents and their share links, and clears the cookie. A team in which the user is the only member goes too, with its maps. The handle of the account and the handles of these teams stay blocked for `HANDLE_HOLD_DAYS`.

Errors: `401 not_logged_in`, `401 wrong_password`, `429 rate_limited`, and `409 last_owner`: the user is the only owner of a team with other members. The message names the teams.

### GET /api/account/export

Needs a session. Response `200` of type `application/zip`, with the file name `it-skills-<handle>-<date>.zip`. The ZIP file holds `account.json` and one map file `<slug>.json` per personal map. `account.json` has the handle, the e-mail address and the language of the account, and it names each map with its title, slug, visibility, embed setting (`allow` and `origins`) and file. Maps of teams are not in it. A member exports each one with `GET /api/maps/{id}/export`.

Errors: `401 not_logged_in`.

## Maps

A map belongs to a user or, from stage c, to a team. A map in an answer (the member view) looks like this:

```json
{"id": "1b7c...", "title": "Meine Kenntnisse", "slug": "meine-kenntnisse", "owner": "anna",
 "visibility": "private", "version": 7, "created": "2026-10-18T22:00:00Z", "updated": "2026-10-18T22:05:00Z",
 "pageUrl": "https://it-skills.net/anna/meine-kenntnisse", "subdomainUrl": "https://anna.it-skills.net/meine-kenntnisse", "size": 5120,
 "embed": {"allow": "all", "origins": [], "url": null}, "ownerType": "user", "role": "owner",
 "ownerUrl": "https://it-skills.net/anna", "start": false}
```

`owner` is the handle of the user or the team. `visibility` is `private`, `link` or `public`. `pageUrl` is the address of the map, `<BASE_URL>/<handle>/<slug>`. `subdomainUrl` is the address on the subdomain of the owner: the user, or the team of a team map. It is `null` without `BASE_DOMAIN`, because the subdomains are an option of the host. A member gets it for every visibility, and a reader view gets it only for a public map. `size` is the sum of the document sizes in bytes. `ownerType` is `user` or `team`. `role` is the role of the signed-in user for the map: `owner` for a personal map, else the role in the team. `ownerUrl` is the address of the owner, `<BASE_URL>/<handle>`. `start` is true when the map is the start map of its owner, which `ownerUrl` shows while the map is public. A reader view (a visitor without a role) has no `id`, no `size`, no `embed`, no `ownerType`, no `role`, no `ownerUrl` and no `start`.

`embed` says who can show the embed view of the map in a frame:

- `allow` is `all` (every site, the default) or `origins` (only the sites in `origins`).
- `origins` is the list of origins, such as `https://example.org`. If `allow` goes back to `all`, the list stays.
- `url` is the embed view of a public map, `<BASE_URL>/e/<handle>/<slug>`. The handle is the handle of the owner, so a map of a team has `<BASE_URL>/e/<team handle>/<slug>`. It is `null` for a map that is not public. A map that is shared by link embeds through its read link (`embedUrl` of `GET /api/maps/{id}/shares`).

Who may do what with a map:

| Action | Personal map | Map of a team |
|---|---|---|
| Read the map, its documents and its access answer; export it | the user, everyone for a public map | every member, everyone for a public map (export: members only) |
| Write documents, rename, change the slug, delete | the user | owner, editor |
| Change the visibility, the embed setting or the start map, get the read link, create a new one | the user | owner |
| Move into a team | the user | nobody |

Embedding shows the map on other sites, so it is a form of sharing. For that reason, a change of the embed setting needs the same right as a change of the visibility.

### GET /api/maps

Needs a session. Response `200`: `{"maps": [<map with "shares": <number of share links, 0 or 1>>, ...]}`, the personal maps of the user, newest change first. The maps of a team are at `GET /api/teams/{handle}/maps`. Errors: `401 not_logged_in`.

### POST /api/maps

Needs a session. Request: `{"title": "Meine Kenntnisse", "slug": "optional", "visibility": "private", "team": "optional"}`. Only `title` is required. With `team` (a team handle), the map belongs to that team. That needs the role owner or editor.

Response `201`: the new map with version 1. Without `slug`, the server makes one from the title: "ä" becomes "ae", a reserved word gets "-map", such as `api-map`, and a slug that exists gets "-2", "-3" and so on. If another request takes the slug at the same moment, a slug that the request names gets `409 slug_taken`, and a slug that the server makes becomes the next free one.

Errors:

| Status | Code | Reason |
|---|---|---|
| 400 | `invalid_title` | Without the white space at both ends, the title does not have 1 to 120 characters (`max`). Or it holds a control character or one half of a UTF-16 pair. The site and `selfhost/FORMAT.md` have the same limit. |
| 400 | `invalid_slug` | The slug breaks the rules: 1 to 60 characters, a to z, 0 to 9 and "-", no "-" at the start or the end, and no "--". Some words are reserved, because a slug is also a path on the subdomain of the owner: `api`, `u`, `s`, `account`, `konto`, `static`, `assets`, `vendor`, `embed`, `favicon` and `robots`. |
| 400 | `invalid_visibility` | The value is not `private`, `link` or `public`. |
| 409 | `slug_taken` | Another map of the same owner has the slug. |
| 409 | `too_many_maps` | The owner (the user or the team) has `MAX_MAPS_PER_OWNER` maps. |
| 401 | `not_logged_in` | No session. |
| 403 | `forbidden` | The user is a reader of the team, or an editor who sends a `visibility` other than `private`. |
| 404 | `not_found` | The team does not exist, or the user is no member. |

### GET /api/maps/{id}

Response `200`: the map. A user with a role gets the member view. Everyone else can read a public map and gets the reader view. Errors: `404 not_found`.

### PATCH /api/maps/{id}

Needs the role owner or editor. Request: any of `{"title": "...", "slug": "...", "visibility": "...", "embed": {...}, "start": true}`. A change of `visibility`, of `embed` or of `start` needs the role owner. If a request sends the current value, the value does not change, and the role editor is enough.

`start` is `true` or `false`, and nothing else. `true` makes the map the start map of its owner. An owner has one start map, so the map before it stops being the start map. `false` ends it for this map. A map that is not public can be the start map: then `<BASE_URL>/<handle>` shows the list of the public maps until the map is public. A move into a team ends the start map of the user, and a delete of the map ends it too.

`embed` takes `{"allow": "all"}`, `{"allow": "origins", "origins": ["https://example.org", "http://localhost:8080"]}`, or only `{"origins": [...]}`. A field that the request leaves out stays as it is. The server stores each origin as `scheme://host[:port]`: it turns capitals into small letters and removes a default port and a closing "/". A list holds each origin once.

Response `200`: the changed map. A change raises the version, like every write.

Errors: as for `POST /api/maps`, and these:

| Status | Code | Reason |
|---|---|---|
| 400 | `invalid_embed` | `allow` is not `all` or `origins`. |
| 400 | `invalid_origin` | An origin is not `http://` or `https://` with a host name and an optional port. A path, a query, a user name, a wildcard, an IPv6 address and a host name without a dot, other than `localhost`, are invalid. |
| 400 | `too_many_origins` | The list has more than 20 origins. |
| 403 | `forbidden` | The user is a reader of the team, or an editor who changes `visibility`, `embed` or `start`. |
| 404 | `not_found` | No map, or the user has no role for it. |
| 409 | `conflict` | Another request moved the map to another owner during a change of `start`. The variant is `moved`. |
| 422 | `invalid_request` | `start` is not `true` or `false`. |

### DELETE /api/maps/{id}

Needs the role owner or editor. Response `204`. The documents and the read link go with the map. If the map is the start map of its owner, the owner has no start map after it.

Errors: `401 not_logged_in`, `403 forbidden` (a reader of the team), `404 not_found`, and `409 conflict` (another request moved the map to another owner at the same moment).

### GET /api/maps/{id}/access

Response `200`: `{"canWrite": true, "role": "owner"}`. `canWrite` is true for the roles owner and editor. `role` is `owner`, `editor`, `reader`, or `null` for a visitor of a public map. Errors: `404 not_found` for everyone else.

### POST /api/maps/{id}/move

Needs the user of a personal map. Request: `{"team": "team-nord"}`. The user must be an owner or an editor of that team.

Response `200`: the map, now with the team as owner. The map keeps its id and its documents, and its version rises by one. Its slug stays, or gets "-2" if the team has a map with that slug.

Every move makes the map private, with embedding off (`{"allow": "origins", "origins": []}`), also for an owner of the team. The server deletes its read link, so its public addresses and its link stop working. An owner of the team can share the map again in the team, with a new link. The reason: an editor cannot change the visibility of a team map. So a move that kept a public map public was a way around the right to share.

Errors:

| Status | Code | Reason |
|---|---|---|
| 400 | `not_own_map` | The map belongs to a team already. |
| 403 | `forbidden` | The user is a reader of the target team, or an editor or a reader of the team that owns the map. |
| 404 | `not_found` | The map or the team is unknown, or the user is no member. |
| 409 | `too_many_maps` | The team has `MAX_MAPS_PER_OWNER` maps. |
| 401 | `not_logged_in` | No session. |

### GET /api/maps/{id}/docs

A user with a role, or anyone for a public map. Query: `since` (optional, a version, 0 or more).

Response `200`:

```json
{"canWrite": true, "version": 7, "full": true,
 "docs": [{"collection": "skills", "id": "python", "data": {"name": "Python", "group": "sd-lang"}}],
 "deleted": []}
```

- Without `since`, `full` is `true` and `docs` holds every document, sorted by collection and id.
- With `since` equal to the version, the answer is `304` with no body.
- With `since` below the version, `full` is `false`. `docs` holds the documents that changed after that version, and `deleted` holds `{"collection", "id"}` of the documents that were deleted after it.
- With `since` above the version, the answer is the full list.
- The version and the documents of an answer come from one snapshot of the database. So a write at the same moment is either in the answer with its version, or in the next poll. The same holds for the documents of a public map and of a share link.

Errors: `404 not_found`, `422 invalid_request` (negative `since`).

### PUT /api/maps/{id}/docs/{collection}/{docId}

Needs the role owner or editor. The body is the document: a JSON object. Encode `docId` in the path, for example with `encodeURIComponent`.

Query: `base` (optional, a version, 0 or more). It is the version that the writer knows the document from: the version of its last read of the map, or the version of its own last write of this document, whichever is higher. If the document changed after `base`, the answer is `409 conflict` and nothing changes. Without `base`, the write never conflicts.

Response `200`: `{"version": 8}`

Errors:

| Status | Code | Reason |
|---|---|---|
| 400 | `invalid_collection` | The name does not match `^[a-z][a-z0-9_-]{0,40}$`. |
| 400 | `invalid_id` | The id has 0 or more than 200 characters, a control character or one half of a UTF-16 pair. Or it is `.`, `..` or `__proto__`. Or it breaks the stricter rule of `areas`, `stations` or `groups` (`selfhost/FORMAT.md`), and `params.variant` names that collection. The site applies the same rules before it writes. |
| 400 | `invalid_document` | The body is not an object, or it holds NaN, Infinity, a null character, one half of a UTF-16 pair in a key or a value, or more than 64 levels. JSON can write such a half as `\ud83d`, but no UTF-8 text holds it. |
| 409 | `conflict` | The document changed after `base`. The server keeps the newer state. |
| 413 | `document_too_large` | The document has more than 256 KB as compact JSON. |
| 413 | `map_too_large` | After the write, the map has more than 4 MB. The server keeps the old state. |
| 401 | `not_logged_in` | No session. |
| 403 | `forbidden` | The user is a reader of the team. |

A "/" never reaches a document id: the server decodes `%2F` in the path before it finds the route, so such a path gives `404 not_found`. A client removes `.` and `..` from a path, so only a map file can name them.

### DELETE /api/maps/{id}/docs/{collection}/{docId}

Needs the role owner or editor. Query: `base`, as for `PUT`. A document that somebody else deleted already is no conflict.

Response `200`: `{"version": 9}`. If the document does not exist, nothing changes and the version stays.

Errors: `400 invalid_collection`, `400 invalid_id` (the rules of `PUT`), `401 not_logged_in`, `403 forbidden`, `404 not_found`, `409 conflict`.

### GET /api/maps/{id}/export

Needs a session and a role: owner, editor or reader. Response `200`: the map file, with `Content-Disposition: attachment; filename="<slug>.json"`. Errors: `401 not_logged_in`, `404 not_found` (also for a visitor of a public map without a role).

```json
{"format": "it-skills-map", "schema": 1, "title": "Meine Kenntnisse", "exportedAt": "2026-10-18T22:00:00Z",
 "collections": {"skills": {"python": {"name": "Python"}}}}
```

### POST /api/maps/import

Needs a session. The body is a map file. Query: `team` (optional, a team handle). With `team`, the map belongs to that team, which needs the role owner or editor. Response `201`: the new private map with version 1.

The server applies the rules of `selfhost/FORMAT.md` to the file, as the site does. So a file that one of them takes, the other takes too. A file can write `schema` as `1.0`: that is the whole number 1. The server makes each run of white space in the title one space, removes the spaces at both ends and keeps the first 120 characters. A file without a title, or with an empty one, gets the title "Imported map" in the language of the account. In German, that is "Importierte Map" (`server/app/i18n/<language>/content.json`). Errors:

| Status | Code | Reason |
|---|---|---|
| 422 | `invalid_map_file` | The file is no object, or it has no valid schema or no collections. |
| 422 | `wrong_format` | The value of `format` is not `it-skills-map`. |
| 422 | `unsupported_schema` | The schema is newer than 1. |
| 400 | `invalid_collection`, `invalid_id`, `invalid_document` | As for a document write. |
| 400 | `invalid_title` | The title is not a text, or it holds a control character or one half of a UTF-16 pair. |
| 401 | `not_logged_in` | No session. |
| 413 | `document_too_large`, `map_too_large` | As for a document write. |
| 409 | `too_many_maps` | The owner has `MAX_MAPS_PER_OWNER` maps. |
| 403 | `forbidden`, 404 `not_found` | As for `POST /api/maps` with `team`. |

### GET /api/maps/{id}/shares

A map has one read link at most. The server keeps its token, so the owner can copy the link again at any time.

Needs the role owner. Errors: `401 not_logged_in`, `403 forbidden` (an editor or a reader of the team), `404 not_found`. Response `200`:

```json
{"visibility": "link",
 "shares": [{"id": "...", "mode": "read", "created": "2026-10-18T22:00:00Z", "token": "<32 characters>",
             "url": "https://it-skills.net/s/<token>", "embedUrl": "https://it-skills.net/e/s/<token>"}]}
```

`shares` is empty for a map without a link. Each call gives the same link until the owner makes a new one. `url` is the map page of the link, and `embedUrl` is its embed view. `mode` is always `read`. The list leaves room for a link of another mode later.

A private map pauses its link: the link gives `404`, and the list still names it. When the map is `link` or `public` again, the same link works again.

### POST /api/maps/{id}/shares

Needs the role owner. Request: no body, or `{"replace": true}`. `replace` is `true` or `false`, and nothing else.

- A map with a read link keeps it. The answer is `200` with that link, so a client that posts to get the link does not revoke it.
- A map without a link gets a new one. The answer is `201`.
- `{"replace": true}` revokes the link and makes a new one in the same transaction, with `201`. The old token gives `404` at once at `/s/<token>`, `/e/s/<token>` and `/api/shared/<token>`, also in a frame on another site. This is the only way to revoke a link. The share dialog sends it only from "Revoke and generate new link".

Two requests at the same moment run one after the other, and one link is left. Without `replace`, both get the same link.

Response `200` or `201`: the link, as in the list, and the visibility of the map:

```json
{"id": "...", "mode": "read", "created": "2026-10-18T22:00:00Z", "token": "<32 characters>",
 "url": "https://it-skills.net/s/<token>", "embedUrl": "https://it-skills.net/e/s/<token>", "visibility": "link"}
```

If the map was private, it becomes `link`, so that the link works. That holds also for a map that keeps its link.

Errors: `401 not_logged_in`, `403 forbidden` (an editor or a reader of the team), `404 not_found`, `422 invalid_request` (`replace` is not `true` or `false`).

## Teams (stage c)

A team in an answer looks like this:

```json
{"handle": "team-nord", "name": "Team Nord", "role": "owner", "created": "2026-10-18T22:00:00Z",
 "profileUrl": "https://it-skills.net/team-nord", "siteUrl": "https://team-nord.it-skills.net",
 "canManage": true, "canEdit": true}
```

`role` is the role of the signed-in user: `owner`, `editor` or `reader`. `canManage` is true for an owner. `canEdit` is true for an owner and an editor. `profileUrl` is the address of the team, `<BASE_URL>/<handle>`. `siteUrl` is `null` without `BASE_DOMAIN`. A member in a list looks like `{"handle": "anna", "role": "owner", "joined": "2026-10-18T22:00:00Z"}`. The list shows the owners first, then the editors, then the readers. In each role, the members are sorted by handle.

Every team endpoint needs a session (`401 not_logged_in`). A user who is no member of the team gets `404 not_found`. A member without the role for the action gets `403 forbidden`.

### POST /api/teams

Request: `{"name": "Team Nord", "handle": "team-nord"}`

Response `201`: the team with `"members": [<the user as owner>]`. The user is the first owner.

Errors:

| Status | Code | Reason |
|---|---|---|
| 400 | `invalid_name` | The name does not have 1 to 100 characters, or it holds a character of the Unicode categories Cc, Cf, Zl, Zp or Cs: a control character, a format character such as a zero-width space, a line or paragraph separator, or one half of a UTF-16 pair. The name goes into the subject of each invitation mail. |
| 400 | `invalid_handle`, `reserved_handle` | As for a user handle. Teams and users share one namespace. |
| 409 | `handle_taken` | A user or a team has the handle, or another owner freed it less than `HANDLE_HOLD_DAYS` ago. Both get the same answer. |
| 409 | `too_many_teams` | The user is an owner of `MAX_TEAMS_PER_USER` teams. |

### GET /api/teams

Response `200`: `{"teams": [<team with "members": <count> and "maps": <count>>, ...]}`, the teams of the user, sorted by name.

### GET /api/teams/{handle}

Any member. Response `200`: the team with `"members": [<member>, ...]`.

### PATCH /api/teams/{handle}

Needs the owner role. Request: any of `{"name": "...", "handle": "..."}`.

Response `200`: the changed team with its members. A new handle changes the addresses of the public maps of the team. Share links keep working. The old handle stays blocked for every other owner for `HANDLE_HOLD_DAYS`. The team can take it back. `409 handle_taken` also answers a handle that another owner freed during its hold.

Errors: `400 invalid_name`, `400 invalid_handle`, `400 reserved_handle`, `409 handle_taken`, `403 forbidden`.

### POST /api/teams/{handle}/delete

Needs the owner role. Request: `{"password": "<password of the owner>"}`

Response `204`. The server deletes the team, its members, its invitations, its maps, their documents and their share links. Its handle stays blocked for `HANDLE_HOLD_DAYS`.

Errors: `401 wrong_password`, `403 forbidden`, `429 rate_limited` (as for the account delete).

### GET /api/teams/{handle}/maps

Any member. Response `200`: `{"maps": [<map with "shares": <number of share links, 0 or 1>>, ...]}`, newest change first. Each map has `"ownerType": "team"` and the role of the user.

### PATCH /api/teams/{handle}/members/{member}

Needs the owner role. `member` is the handle of the member. Request: `{"role": "editor"}`

Response `200`: the member with the new role.

Errors:

| Status | Code | Reason |
|---|---|---|
| 400 | `invalid_role` | The role is not `owner`, `editor` or `reader`. |
| 404 | `not_found` | The user is no member of the team. |
| 409 | `last_owner` | The member is the last owner, and the new role is not `owner`. |
| 409 | `too_many_teams` | The new role is `owner`, and the member is an owner of `MAX_TEAMS_PER_USER` teams already. The variant is `member`. |

### DELETE /api/teams/{handle}/members/{member}

An owner removes any member. Every member removes himself: that is leaving the team. Response `204`.

Errors: `403 forbidden` (an editor or a reader removes someone else), `404 not_found`, `409 last_owner` (the member is the last owner).

### GET /api/teams/{handle}/invitations

Needs the owner role. Response `200`:

```json
{"invitations": [{"id": "...", "email": "bert@example.org", "role": "editor",
  "created": "2026-10-18T22:00:00Z", "expires": "2026-10-25T22:00:00Z", "invitedBy": "anna"}]}
```

The list holds only open invitations: not accepted, not withdrawn and not expired. `invitedBy` is `null` if the account of the sender is gone.

### POST /api/teams/{handle}/invitations

Needs the owner role. Request: `{"email": "bert@example.org", "role": "editor"}`

Response `201`: `{"status": "invited", "message": "...", "invitation": <invitation>}`. The answer is the same whether the address has an account or not. The server sends a mail with a link to `/account#invite=<token>`, in the language of the confirmed account with that address, or else in the language of the user who invites. The token has 256 random bits, and the server stores only its hash. The invitation is valid for 7 days and works once. A new invitation to the same address replaces the open one.

Errors:

| Status | Code | Reason |
|---|---|---|
| 400 | `invalid_email` | The address is not valid, as for `POST /api/auth/register`. |
| 400 | `invalid_role` | The role is not `owner`, `editor` or `reader`. |
| 429 | `rate_limited` | Too many invitations from this user (`RATE_LIMIT_INVITE_USER`) or to this address (`RATE_LIMIT_INVITE_EMAIL`). |

### DELETE /api/teams/{handle}/invitations/{id}

Needs the owner role. Response `204`. The link stops at once. Errors: `404 not_found` (unknown, accepted or already withdrawn).

## Invitations

The invited person sends the token from the link. The account page reads it from `#invite=<token>` and keeps it in the browser while the person signs in or registers.

### POST /api/invitations/lookup

No session needed. Request: `{"token": "<token from the mail>"}`

Response `200`:

```json
{"team": {"handle": "team-nord", "name": "Team Nord"}, "role": "editor", "invitedBy": "anna",
 "expires": "2026-10-25T22:00:00Z", "memberRole": null}
```

`memberRole` is the current role of the signed-in user in the team, or `null`.

Errors: `400 invalid_token`. The token is unknown, accepted, withdrawn or older than 7 days.

### POST /api/invitations/accept

Needs a session. Any account can accept: the e-mail address of the account does not have to match the invitation. Request: `{"token": "..."}`

Response `200`: the team with its members. The user is now a member with the role of the invitation.

Errors: `401 not_logged_in`, `400 invalid_token`, `409 already_member` and `409 too_many_teams`. The invitation stays open after a `409`. `too_many_teams` means: the role is `owner`, and the user is an owner of `MAX_TEAMS_PER_USER` teams already.

## Readers

These endpoints need no session and never write.

### GET /api/public/{handle}

Response `200`: `{"owner": "anna", "profileUrl": "https://it-skills.net/anna", "siteUrl": "...", "maps": [<reader view of each public map>]}`, newest change first. The handle can be a user or a team. Errors: `404 not_found` for an unknown or unconfirmed handle, and for an owner without a public map. The three answers are the same, so the endpoint does not tell whether an account exists. The endpoint never reads the session, so the owner gets the `404` too.

### GET /api/public/{handle}/{slug}

Response `200`: the reader view of the public map. Errors: `404 not_found`. The map does not exist or is not public.

### GET /api/public/{handle}/{slug}/docs

Like `GET /api/maps/{id}/docs`, with `"canWrite": false`. Polling with `since` works the same way.

### GET /api/public/{handle}/{slug}/access

Response `200`: `{"canWrite": false}`. Reads through this path never write, also for the owner. The page of a user with a role gets `/api/maps/{id}` as its source instead.

### GET /api/shared/{token}

Response `200`: the reader view of the map behind the link. Errors: `404 not_found`. The link is revoked, the token is unknown, or the map is private.

### GET /api/shared/{token}/docs

Like `GET /api/maps/{id}/docs`, with `"canWrite": false`.

### GET /api/shared/{token}/access

Response `200`: `{"canWrite": false}`.

### GET /api/health

Response `200`: `{"status": "ok"}`. If the database does not answer, the response is `503` with `{"status": "down"}`.

### GET /api/openapi.json

Response `200`: the endpoints of the API in the OpenAPI format, as FastAPI makes it from the code. This file, `API.md`, describes them for people.

## Pages

The app also sends HTML pages. The proxy passes `/`, `/index.html`, `/api`, `/s`, `/e` and `/account` of the main domain to the app. It also passes every path of one or two names without a dot, in the characters of handles and slugs: `/<handle>` and `/<handle>/<slug>`, also with "/" at the end. Every other path is a file of the site. On each subdomain, it passes `/`, `/<slug>` and `/<handle>/<slug>`, also with "/" at the end, and `/api` and `/s`.

The addresses are paths below the main domain: `<BASE_URL>/<handle>` for an owner and `<BASE_URL>/<handle>/<slug>` for a map. The subdomains are an option of the host. A handle shares the top-level paths with the site and the app, so no handle can be a top-level name of either (see `reserved_handle`).

| Path | Page |
|---|---|
| `/` and `/index.html` on the main domain | The start page of the site (`START_FILE`) with the data block of the server: `{"mode": "site", "account": "<BASE_URL>/account", "user": {"handle": "anna"}, "language": "de"}`. `user` and `language` are `null` without a session. Without `START_FILE`, `/` is a redirect to `/account`. |
| `/account/account.js`, `/account/account.css` | The script and the style of the account page, with the policy of `/account`. |
| `/account` | The account page, with the data block `{"mode": "account", "user": {"handle": "anna"}, "language": "de"}` right after `<head>`, and `Cache-Control: no-store`. `user` and `language` are `null` without a session. On a subdomain, a redirect to `BASE_URL/account`. `#register` and `#login` open those tabs. After a login, `?next=<path>` leads back to a page of the site. |
| `/{handle}` | The address of a user or a team. It shows the start map of the owner while that map is public, as `/{handle}/{slug}` shows it to the visitor. Else it lists the public maps of the owner, with `Cache-Control: no-store`. An unknown handle gets the 404 page. An owner without a public map gets the same 404 page, byte for byte, so the address does not tell whether an account exists. Only the user himself and the members of a team get the empty list there. |
| `/{handle}/{slug}` | The map page. A user with a role (the user of a personal map, a member of the team) gets it for every visibility, with write access for owner and editor. Everyone else gets it for a public map. |
| `/s/{token}` | The map page of a share link, read-only, with `Referrer-Policy: no-referrer`. |
| `/e/{handle}/{slug}` | The embed view of a public map of a user or a team. Other sites can frame it. |
| `/e/s/{token}` | The embed view of a share link. Other sites can frame it. |
| `/` on `<handle>.<BASE_DOMAIN>` | The address of the owner, as `/{handle}`: the start map, the list or the 404 page. |
| `/{slug}` on `<handle>.<BASE_DOMAIN>` | The map page of a map of the owner. The own handle of the subdomain is a slug too: when the visitor may read a map with that slug, `/<handle>` shows it. Else it is a `308` to `/` of the subdomain. |
| A page path with "/" at the end | When a page has the same address without the "/", the answer is a `308` to that address, with the query. The app builds the address from `BASE_URL`, or from the address of the subdomain. It never names `http://` or another host. A path of the API with "/" at the end gets `404 not_found`. |

A subdomain is the site of one owner, so it serves only the maps of that owner. On `<handle>.<BASE_DOMAIN>`, every path that names a map or the list of another owner gets `404`: `/{handle}/{slug}` of another handle, `/s/{token}`, `/api/public/...`, `/api/shared/...` and `/api/maps/{id}...`. The embed views `/e/...` and `/index.html` give `404` on every subdomain, and `/account` sends the browser to `BASE_URL/account`. The main domain serves the maps of every owner.

A name below `BASE_DOMAIN` that is no free handle names no user site. `www.<BASE_DOMAIN>` sends the browser to the same path and query on `BASE_URL`, with `308`, so that a write keeps its method. Every other such name gets `404` for every path, also for the API and the files of the site. Such a name is a reserved one, such as `api`, or a name that is no handle. When `BASE_URL` names `www.<BASE_DOMAIN>` itself, `www` is the main domain.

### Embed views and framing

- An embed view never reads the session and sets no cookie. For a map that is not public, `/e/{handle}/{slug}` is a 404, also for its owner and the members of its team. A revoked link, an unknown token and the link of a private map give a 404 at `/e/s/{token}`.
- Each answer sends the Content-Security-Policy of the site (`SITE_POLICY` in `app/pages.py`) with `base-uri 'self'` and the `frame-ancestors` of its page. The meta tag of each page of the site holds the same policy.
- If `embed.allow` is `all`, an embed view sends `frame-ancestors *`. If it is `origins`, the view sends `frame-ancestors 'self' <origins>`. It sends no `X-Frame-Options`, and it sends `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
- The 404 page of an embed address sends `frame-ancestors *`, so that the frame on the other site says "Not found" ("Nicht gefunden" in German). It is the same page for every reason.
- Every other answer sends `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`. `/account` has its own policy with `frame-ancestors 'none'`, and it sends `X-Frame-Options: DENY`.
- The query string of an embed view takes `theme=auto|light|dark` and `panel=1|0`. The page reads them, not the server. `README.md` explains them.

## For the page runtime

A map page is the file in `PAGE_FILE`: `server-map.html` of `npm run build:selfhost`, the map page of stage a with the runtime `selfhost/runtime/server.js`. The app adds a data block right after `<head>`. If the page has no `<base>` tag, the app puts `<base href="/">` before the block. The block is JSON, not a script, because the policy of the site runs no inline script. In the JSON, the app writes each `<` as `\u003c`, and the line separators U+2028 and U+2029 as `\u2028` and `\u2029`, so no text of a map can end the block. `assets/runtime-local.js` reads the block into `window.IT_SKILLS_SERVER` for the other scripts of the page. The block is:

```html
<script type="application/json" id="it-skills-server">{"mode": "owner", "api": "/api/maps/1b7c...", "canWrite": true,
  "map": {"title": "Meine Kenntnisse", "slug": "meine-kenntnisse", "owner": "anna", "visibility": "public"},
  "account": "https://it-skills.net/account", "language": "de", "role": "owner", "canShare": true}</script>
```

`language` is the language of the signed-in account, or `null` without a session. `assets/i18n.js` shows the page in it. The embed view never reads the session, so its `language` is always `null`.

`mode` is `owner`, `public`, `shared` or `embed`. `api` is `/api/maps/{id}` for the owner, `/api/public/{handle}/{slug}` for a public map and `/api/shared/{token}` for a share link. An embed view uses the `api` of the public map or of the share link, and its data block has one more field: `"embed": {"open": "<the full map page>"}`. Its runtime then offers `features.embed = {theme, panel, open, site}` and sends its requests without cookies.

From stage c, `mode` is `owner` for every user with a role for the map, also for an editor or a reader of a team. Then the data block has two more fields: `"role": "owner" | "editor" | "reader"` and `"canShare"`. `canWrite` follows the right to write: it is true for an owner and an editor, and false for a reader. `canShare` follows the right to share: it is true only for an owner. The runtime takes write access only from `canWrite`, and it shows "Share" only with `canShare`. It never takes a right from `mode` or `role`. `GET {api}/access` gives the same `canWrite` and `role`, for a runtime that does not read the data block.

The runtime maps the interface of the page to the API like this:

| Page interface | API |
|---|---|
| `runtime.isOwner()` | `canWrite` of the data block, and of the first answer of `{api}/docs` |
| `db.collection(c).onSnapshot(next)` | `GET {api}/docs` once, then `GET {api}/docs?since=<version>` every 3 seconds while the tab is visible. The documents stay in memory, grouped by `collection`. |
| `db.collection(c).doc(id).set(data)` | `PUT {api}/docs/{c}/{encodeURIComponent(id)}?base=<version>` with the body `data` and the two write headers. One write at a time for each document. |
| `db.collection(c).doc(id).delete()` | `DELETE {api}/docs/{c}/{encodeURIComponent(id)}?base=<version>` with the two write headers |
| `runtime.rename(title)` | `PATCH /api/maps/{id}` with `{"title": ...}` |
| `runtime.openMapFile(file)` | `POST /api/maps/import` with the map file that the runtime read, then the page of the new map |
| "Share" (only with `canShare`) | `GET /api/maps/{id}`, `PATCH /api/maps/{id}` with `visibility` or `start`, `GET` and `POST /api/maps/{id}/shares`. "Create link" posts without a body. Only "Revoke and generate new link" sends `{"replace": true}`. The addresses are `pageUrl` and, only on a host with subdomains, `subdomainUrl` of the map. The box of the start map names `ownerUrl`. |
| "Embed" in "Share" | `embed` of `GET /api/maps/{id}`, `PATCH /api/maps/{id}` with `embed` or `visibility`, and `embedUrl` of the read link (`GET` and `POST /api/maps/{id}/shares`) |

The runtime sends each write with `keepalive` while the bodies of its writes in flight fit 64 KB, the limit of the browser. A write with `keepalive` still reaches the server when the visitor leaves the page or closes the tab. A larger body goes without `keepalive`.

A second write of a document waits until the first one ends. When the page goes (`pagehide`), the runtime sends the newest waiting write of each document at once, without `base`. A write holds the whole document, so the newest one replaces the older waiting ones. The version of the first write is not known yet. Without `base` the newest write lands, and the first write, which carries its `base`, gets `409 conflict` if it ends later.

The runtime gives the page these error codes: `unauthenticated` (401), `not_found` (404), `conflict` (409), `quota_exceeded` (413), `resource_exhausted` (429), `unavailable` (no connection or 5xx), `permission_denied` (a reader, or 403) and `invalid_argument` (every other 4xx). Only `permission_denied` makes the page read-only for the visit. Any other 4xx fails that one write, and the runtime shows the text of its code in the language of the page (`SkillMapI18n.errorText`), or the `message` of the answer. For an ended session, the message links to `account?next=<path of the map>`.
