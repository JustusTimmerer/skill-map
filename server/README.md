# Server for stages b and c

This folder holds the backend of stages b and c. In stage b, users register, store their maps on the server, and share them read-only. Stage c adds teams: several users work on the maps of a team, and each user has a role in the team. A Docker Compose stack runs the backend with these services:

| Service | Image | Job |
|---|---|---|
| `db` | `postgres:17.11-alpine3.23` | PostgreSQL 17 with all data |
| `db-setup` | `postgres:17.11-alpine3.23` | Runs once at each start, before `app`: the role of the app without admin rights (section "Database roles") |
| `app` | built from `Dockerfile` (Python 3.13, FastAPI) | The API, the map pages and the account page |
| `proxy-setup` | `caddy:2.11.7-alpine` | Runs once at each start, before `proxy`: it gives the volumes of the proxy to the user of the proxy (section "Container rights") |
| `proxy` | `caddy:2.11.7-alpine` | TLS, the files of the site, and the routes to the app |
| `mailpit` | `axllent/mailpit:v1.31.6` | Catches every mail on this computer (profile `local`) |
| `tests` | built from `Dockerfile` (target `test`) | Runs pytest in the stack (profile `test`) |

Every image is pinned by tag and digest. Every Python package is pinned in `requirements.txt` and `requirements-dev.txt`, the transitive ones too. The images of `app` and `tests` have no fixed name. Compose names them after the project, for example `skill-map-server-app`. So two stacks from two folders on one computer never use the same image.

## Start it on this computer

You need Docker with Compose, and Node for the build of the site. Run these commands in the root of the repository:

```
npm run build:selfhost
cp server/.env.example server/.env
docker compose -f server/compose.yaml up -d --build
```

Before the last command, set `POSTGRES_PASSWORD` in `server/.env` to a long random value. Leave `POSTGRES_APP_PASSWORD` empty. Then `db-setup` makes a password of its own for the role of the app (section "Database roles"). Then open these pages:

- https://it-skills.localhost:8443/ is the start page. It offers both ways: "Without an account, in the browser" (stage a) and "Save with an account".
- https://it-skills.localhost:8443/account is the account page: register, sign in, and manage the maps.
- http://localhost:8025 is mailpit. The confirmation mail and the reset mail arrive there.

The stack mounts `dist/selfhost`. After a new build of the site, a reload of the page shows it. The stack does not need a restart.

Chrome, Edge and Firefox send every name below `.localhost` to 127.0.0.1, so `anna.it-skills.localhost` works without a hosts file. The certificate comes from the local CA (certificate authority) of Caddy, so the browser shows a warning once. To remove the warning, copy the root certificate and import it into the trust store of the system:

```
docker compose -f server/compose.yaml cp proxy:/data/caddy/pki/authorities/local/root.crt caddy-local-root.crt
```

To stop the stack, run `docker compose -f server/compose.yaml down`. The data stays in the Docker volumes `db_data`, `caddy_data` and `caddy_config`. To remove the data too, add `-v`.

## Try it

1. On the start page, click "Register". Enter an e-mail address, a name and a password.
2. Open mailpit and click the link in the mail. The account page asks for the password of the registration, and then it confirms the account. Sign in.
3. Go back to the start page. The card "Your maps in the account" now lists the maps of the account. Click "New map from the default set", or import a map file of stage a with "Import map file".
4. The map opens at `/<name>/<slug>`. Add areas, categories and skills. Each change goes to the server at once.
5. Click "Share" in the map. Choose "With link" and click "Create a new link", then "Copy". The link opens the map read-only, also in a browser without an account. The reader sees each change of the owner after a few seconds.
6. Choose "Public". The map is now at `/<name>/<slug>` and at `https://<name>.it-skills.localhost:8443/<slug>`. Tick "Also show this map at ..." below the address. Then `/<name>` shows this map.
7. In "Share", go to "Embed" and click "Copy". Paste the code into an HTML page of another site. The section "Embedding" below shows a way to try it on this computer.

## One stack: the site, the API, the account page and the maps

The proxy and the app share one folder: `dist/selfhost`, the build of `npm run build:selfhost`. Compose mounts it at `/srv/site` in both containers. The table shows who answers which address on the main domain.

| Address | Answer |
|---|---|
| `/` and `/index.html` | The app. It sends the start page of the site (`START_FILE`) with the data block of the server, `{mode: "site", account, user}` (`API.md`). With it, the start page shows the card "Save with an account" beside the maps of the browser (`selfhost/site/account.js`). |
| `/account` | The app: the account page. |
| `/api/...` | The app: the API (`API.md`). |
| `/<handle>`, `/<handle>/<slug>`, `/s/<token>` | The app. A map address gets the map page of the server (`PAGE_FILE`, `server-map.html`) with the data block `{mode, api, canWrite, map, account}`. `/<handle>` shows the start map of the owner while it is public, and else the list of its public maps. An unknown handle gets the 404 page of the app. |
| `/e/<handle>/<slug>`, `/e/s/<token>` | The app: the embed view of a public map or of a share link. It is the same map page with mode `embed`. |
| every other address | The proxy: the files of the site, for example `map.html` and `example.html` of stage a, `assets/` and `vendor/`. |

The proxy sends a path of one or two names without a dot, in the characters of handles and slugs, to the app. Each file of the site has a dot or lies below a folder of the site. A handle shares the top-level paths with the site, so every top-level name of the site and of the app is reserved. `node build_selfhost.js` checks the top-level names of the build and of the routes of the app. It stops when such a name has the form of a handle and `RESERVED` in `app/security.py` lacks it. It also stops when `proxy/reserved.caddy` and `RESERVED` differ.

On a subdomain `<handle>.<domain>`, the app answers `/`, `/<slug>`, `/<handle>/<slug>` and `/api/...`, and the proxy sends the files of the site. A subdomain serves only the maps of its own owner. Every address there that names a map or the list of another owner gets 404. A reserved name below the domain is no user site: the proxy sends every path there to the app. The app sends `www` to the main domain with 308, and it answers every other reserved name with 404.

The map page of the server is the map page of stage a with a different runtime: `selfhost/runtime/server.js` in place of `selfhost/runtime/local.js`. That runtime does these things:

- It loads every document of the map once and keeps them in memory.
- An owner writes each change at once, with the header `X-Requested-With: it-skills` and the version that the page knows the document from (`?base=`).
- While the tab is visible, it asks for changes every 3 seconds (`?since=`). A hidden tab does not ask.
- It shows a German message at the top of the page for an ended session, with a link to sign in again. It also shows one for a limit of the server, no connection, a write conflict, and a map or link that is gone.
- The owner gets "Share": private, by link or public, the read link, the public addresses, and "Embed". Readers get no write controls.
- In the embed view, it adds no tools to the header, and its requests send no cookie.

Without an account, a visitor uses stage a on the same site: `map.html` keeps the maps in the browser and never asks the API.

## Embedding

An owner can show a map in a page of another site, for example on a CV page or on the page of a team. The frame always shows the current state of the map. It asks for changes every 3 seconds, as every reader does, so a change of the owner shows up there after a few seconds.

### The embed view

| Address | Map |
|---|---|
| `/e/<handle>/<slug>` | A public map. |
| `/e/s/<token>` | The map of a share link, while the map is shared by link or public. |

A private map never has an embed view. For a map that is not public, `/e/<handle>/<slug>` gives 404, also for its owner. A revoked share link and the link of a private map give 404 too. This 404 page allows every site to frame it, so the frame on the other page says "Nicht gefunden" instead of a browser error. It says the same for every reason.

The embed view is the map page of the server in a compact reader mode:

- It shows the map, the search, the area filter, zoom, and the details of a clicked skill.
- It shows no editor, no force menu, no account controls, no time range, no button "Projects" and no link to the start page.
- Its only link is "Auf it-skills.net öffnen" (with the host name of `BASE_URL`). The link opens the full map in a new tab.
- The mouse wheel scrolls the page around the frame, so the frame does not catch the scroll of a long page. Ctrl and the wheel (⌘ on a Mac) zoom the map, and so do a pinch on a touchpad and the buttons "+" and "−".

The page decides the mode from its runtime. In mode `embed`, `selfhost/runtime/server.js` offers `runtime.features.embed = {theme, panel, open, site}`. `selfhost/site/embed.js` (`assets/embed.js` of the build) then turns the page into the compact reader. The runtime of stage a never offers `features.embed`, so its pages stay as they are.

### Options

The address of the embed view takes two options in its query string:

| Option | Values | Meaning |
|---|---|---|
| `theme` | `auto` (default), `light`, `dark` | `light` and `dark` fix the colors. `auto` follows the system of the reader. |
| `panel` | `1` (default), `0` | `1` shows the panel beside the map. `0` lets the map fill the frame, and a click on a skill shows its details over the map, with a button that closes them. |

In a frame of 760 px or less, the details always show over the map. An unknown value means the default. An example: `/e/anna/meine-kenntnisse?theme=dark&panel=0`.

### The code for the other page

"Share" → "Embed" gives a ready code to copy:

```html
<iframe src="https://it-skills.net/e/anna/meine-kenntnisse" title="Skill-Map: Meine Kenntnisse" loading="lazy"
  style="width:100%;aspect-ratio:16/10;min-height:400px;border:0"></iframe>
```

The minimum height keeps the map readable in the narrow column of a phone. The section also has these parts:

- The two options. A change of an option changes the code at once. "Open preview" opens the embed view with the options in a new tab.
- A short help text in German.
- The choice "Who may embed the map": every website, or only the websites of a list.
- For a private map: the reason why it cannot be embedded, and the buttons "Make public" and "Create link". If the map has a read link, the second button is "Share with link". It makes the map `link` again, so that the link works again.
- For a map shared by link: the code holds the read link of the map, the same link as above. Anyone who sees the other page can read the link. If the map has no link yet, the section offers "Create link". When the owner revokes the link with "Revoke and generate new link", the frame shows the map no more. The code then needs the new link.

### Framing rules

- Each HTML answer sends the full Content-Security-Policy of the site as a header (`API.md`). Its `frame-ancestors` part holds the framing rule.
- Only the embed view allows other sites to frame it. If every site can embed the map, its policy has `frame-ancestors *`. With a list, it has `frame-ancestors 'self' <origin> ...`. It sends no `X-Frame-Options`.
- Every other answer of the app sends `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`. The account page sends `frame-ancestors 'none'` and `X-Frame-Options: DENY`. The proxy sends `frame-ancestors 'self'` and `SAMEORIGIN` with every file of the site.
- The owner chooses who can embed a map: every site (the default) or only a list of origins. The map stores the choice in the columns `embed_allow` and `embed_origins` (migration `0002_embed.sql`). The API is `PATCH /api/maps/{id}` with `embed` (`API.md`).
- Embedding shows the map on other sites, so it is a form of sharing. For that reason, a change of the embed setting needs the share right (`map.share`), the same as a change of the visibility. For a map of a team, only an owner of the team has that right. An editor who changes the embed setting gets `403`. The page of an editor has no "Share", so it shows no part of "Embed".
- An origin is `https://host` or `http://host`. A port other than the default port follows the host, as in `http://localhost:8080`. The app turns capitals into small letters and removes a default port and a closing "/". It refuses a path, a query, a user name, a wildcard, an IPv6 address and a host name without a dot, other than `localhost`. A list holds 20 origins at most. If the owner switches back to every site, the list stays.
- Browsers enforce `frame-ancestors`. A site that is not on the list shows an error in the frame instead of the map.
- `frame-ancestors *` covers pages over `http` and `https`. A page that the browser opens as a file from the disk gets an error in the frame. Serve such a page with a small web server, as in "Try it on this computer".

### Cookies and the session

- The embed view never reads the session. A signed-in owner gets the same read-only view as every reader, and a map that is not public gives 404 for him too.
- The embed view sets no cookie. Its runtime sends its requests with `credentials: "omit"`, so not even the session cookie of a signed-in owner goes to the server. The page around the frame sees only public content.
- The answer of the embed view has `Referrer-Policy: no-referrer`. So the link of the frame never names the page around it, and a share link does not leak.

### Try it on this computer

The stack must run, with a public map. Then serve a small page of another site on this computer:

1. Make an empty folder, for example `embed-test`.
2. In that folder, write a file `index.html` with the code from "Embed".
3. In that folder, run `python -m http.server 5500 --bind 127.0.0.1`.
4. Open the embed address in a tab of its own, and accept the warning for the certificate of the stack.
5. Open http://127.0.0.1:5500/. The page shows the map in its frame.

To test a list, add `http://127.0.0.1:5500` in "Only these websites". Then serve the same folder on a second port, for example 5501. The page on port 5501 shows an error in the frame.

### Limits

- On a phone, one finger moves the map, as on the full page. The page around the frame scrolls only outside the frame.
- A frame that is outside the screen still asks for changes while its tab is visible.

### Try a team

You need two accounts. Use a second browser or a private window for the second account.

1. Sign in with the first account. Under "Teams", enter a name and an address, for example `team-nord`, and click "Create team".
2. Click "Open" on the team. Under "Invite", enter the e-mail address of the second account, pick "Editor" and click "Send invitation".
3. Open mailpit and open the link in the invitation mail in the second browser. The page shows the team and the role. Sign in there, then click "Accept invitation".
4. In the second browser, create a map under "Your maps". Pick the team in "Move into a team …". The map is now a map of the team. A map that moves into a team always arrives private, with embedding off and without a read link.
5. In the first browser, open the team again. Set the map to "Public". It is now at `/team-nord/<slug>` and at `https://team-nord.it-skills.localhost:8443/<slug>`.
6. Change the role of the second account to "Reader". The second account still reads every map of the team, but it cannot change them.

## Run the tests

The stack must run. Then run this command:

```
docker compose -f server/compose.yaml run --rm --build tests
```

To run a second stack next to the first one, use a second folder with its own `server/.env`. Set other values for `HTTP_PORT`, `HTTPS_PORT`, `MAILPIT_PORT`, `NETWORK_SUBNET`, `PROXY_IP` and `BASE_URL` in it. Then pass a project name with `-p <name>` to every `docker compose` command of that stack.

The tests use the real PostgreSQL and mailpit of the stack, not mocks. They create their own database `<POSTGRES_DB>_test` at the start, so the data of the running app stays as it is. For this, they connect as the admin role `POSTGRES_USER`, not as the role of the app. `tests/test_stack.py` sends requests through the proxy over TLS. It makes sure that the certificate is valid for the local CA, and it follows one public map from the registration to its subdomain. That test deletes its account at the end.

To run one file or one test, add the pytest arguments, for example `pytest -q tests/test_maps.py -k polling`.

The tests of the deploy run Docker on the host, from the root of the repository: `node tests/server/deploy.js`. They need the built site and no running stack. Each part starts its own stacks on the ports 49180, 49543 and 49125 and stops them at the end. The volumes of these test projects stay. The parts:

- `compose` reads `compose.yaml` and `compose.ipv6.yaml` as Compose resolves them: the rights of each container, the ports of HTTP/3, the start order and the password file of the app.
- `stack` starts a fresh stack. It checks the rights inside each running container and the password that `db-setup` makes. It also checks HTTP/3 and the option `WWW_REDIRECT`. Last, it checks the files of the site during a new build and while the app fails.
- `backup` runs `backup.sh` on that stack and checks its loud failures. Then it runs the code blocks of "Restore" as they stand, into a new project, and the test map comes back.
- `upgrade` starts the stack of the version before the rights of the containers (commit `626ac3b`) with data. Then it starts the stack of this checkout on the same volumes.
- `snippets` serves the site with the lines of `selfhost/DEPLOY.md` in real nginx and Apache containers and checks each header.

Pass the names of parts to run only those, for example `node tests/server/deploy.js compose snippets`.

The acceptance test of the whole product runs from the root of the repository against the running stack: `npm run test:release`. It builds the site, proves that the stack serves that build, and uses the product as a visitor, an owner, an editor and a reader do. It also checks the headers, the cache rules, injected markup and forged requests, and in English the mails in the language of their recipient, the language in the data block of each page and the English message of an error. Each run registers 4 accounts and asks for one new password. With the default `RATE_LIMIT_REGISTER_IP` of 10 in an hour, a third run within one hour stops with a message that names the limit.

The tests of stage c:

- `tests/test_access_matrix.py` calls every map, document, team and invitation endpoint as five visitors: an owner, an editor and a reader of the team, a signed-in user who is no member, and a signed-out visitor. Each case asserts one status code, once for a private map and once for a public map. A guard test fails if a route below `/api/maps`, `/api/teams` or `/api/invitations` has no case.
- `tests/test_teams.py` tests the teams, the roles, the last owner, the invitations, the maps of a team and the move of a map.
- `tests/test_errors.py` tests the answer to an error that no route handles: `500 internal` in the JSON format of the API. After it, the same connection through the proxy serves the next request.
- `tests/test_migration.py` builds a database of stage b with the migrations `0001_initial` and `0002_embed`. It fills the database with stage b data and runs the migration of stage c, `0003_teams`, and `0004_language`. It compares every old row. Then it signs in, reads the maps and polls the documents. It opens a share link, a public map and its embed view, and it moves an old map into a new team. It also builds a database with `0001_initial` only and runs the other files. Every old row stays, and each old map gets the defaults of the embed setting. A third database has the data of stage c, with a team, its members and an open invitation, and runs `0004_language`. Every row stays, each account gets English, and the app changes the language and sends each mail in the language of its recipient. Each database also runs `0005_freed_handles`, which starts empty, and `0006_one_share_link`, which deletes the old share links. A fourth database holds several old links, also two of one map. After `0006_one_share_link`, every other row stays, each old link gives 404, and a map takes only one new link.
- `tests/test_handles.py` tests the hold of a freed handle. Each path that frees a handle blocks it, and the hold ends after `HANDLE_HOLD_DAYS`. The owner takes the handle back, and an account that nobody confirmed blocks nothing. A held handle gets the same answer as a taken handle.
- `tests/test_parallel_limits.py` sends parallel requests. They all wait for one lock and then run at the same moment. New maps, imports, moves, new teams and accepted invitations as owner stop exactly at their limits. 8 new maps with one title get 8 slugs. A move and the delete of the account do not wait for each other in a circle. The delete of a team does not wait in a circle with an invitation that somebody accepts or sends at that moment.
- `tests/test_rate_limits.py` tests the limit of the registrations per address, with the same answers for a known and a new address. It also tests each limit per IP with IPv6 clients: two addresses of one /64 network share a bucket.
- `tests/test_languages.py` tests the catalogs of the server, the error body with its values, the language of an account in the API and in the data block of each page, each mail in English and in German, and the small pages of the app with the keys of their texts.
- `tests/test_database_role.py` looks at the sessions of the running app in PostgreSQL. The app connects as a role that is no superuser and cannot create a database or a role. That role also cannot run a program or read a file of the server, and it owns the database and every table. The password of the admin role does not open that role, and the role can connect only to its own database.
- `tests/test_mail_tls.py` tests `SMTP_SECURITY=tls` and `starttls` against a small TLS server in the tests container. The mail goes out only over a verified TLS connection, and the login happens inside it. An unknown certificate authority, a wrong host name and a server without STARTTLS stop the mail. `SMTP_USER` with `SMTP_SECURITY=none` stops the app at its start, and the app never logs in to a mail server without TLS.
- `tests/test_logs.py` makes sure that the app writes no access log. It also starts the app with the start command of the image and reads its log: each migration that the app applies, and the version of the database.

The browser tests of stage b run from the root of the repository against the same running stack:

```
npm run test:server
```

This builds the site and runs `tests/server/run.js` with Playwright. It registers a new account through the account page and opens the link of the mail through the API of mailpit. Then it goes through the maps, the import, the share links, polling, a write conflict and the messages. After that, it tests embedded maps, public maps by path and by subdomain, the logout and stage a without an account. It also uses the account page as a user does: a new map, the import, the ZIP file of all maps and the move of a map into a team. Then it tests the teams: invitations, roles, rename, leave and delete. Last come a password reset, a password change and the delete of the account. At the end it deletes every account and team that it made. For the embedded maps, the test starts two small web servers on 127.0.0.1, each on a free port. They are the other sites that frame the maps. It reads `BASE_URL`, `BASE_DOMAIN` and `MAILPIT_PORT` from the environment or from `server/.env`. Each run registers 2 accounts, signs in or confirms 10 times, and asks for one password reset, which is two requests. The default limits allow about two runs in 15 minutes and five runs in an hour. Then the server tells you to wait. Screenshots go to `tests/server/out/`.

## Environment variables

The stack reads `server/.env`. Compose passes the values to the services. The app reads only environment variables, and `.env.example` lists every value with a short comment.

### App

| Variable | Default | Meaning |
|---|---|---|
| `BASE_URL` | none, required | The address of the site, for example `https://it-skills.net`. A write must come with this value as its `Origin` header. Mails link to it. |
| `BASE_DOMAIN` | empty | The domain of the subdomains. A request to `<handle>.<BASE_DOMAIN>` shows the public maps of that user. Empty turns the subdomains off. |
| `APP_ENV` | `production` | `local` turns off the `Secure` flag of the session cookie. Use it only for plain HTTP without the proxy. |
| `DATABASE_URL` | empty | A libpq connection string. Empty means that libpq reads `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` and `PGPASSWORD`. Compose sets these. |
| `TRUSTED_PROXIES` | empty | IP addresses or networks of proxies, comma-separated. Only a request from one of them can name the client with `X-Forwarded-For`. Compose sets the address of the proxy. |
| `SMTP_HOST`, `SMTP_PORT` | `localhost`, `25` | The mail server. Compose uses `mailpit` and `1025`. |
| `SMTP_USER`, `SMTP_PASSWORD` | empty | The login at the mail server. Empty means no login. The app logs in only inside TLS, so `SMTP_USER` needs `SMTP_SECURITY` `starttls` or `tls`. With `none`, the app does not start (section "Mail"). |
| `SMTP_SECURITY` | `none` | `none`, `starttls` or `tls`. `none` sends the mails in plain text and allows no login. mailpit of the local stack needs no login. |
| `MAIL_FROM` | `it-skills <no-reply@<host of BASE_URL>>` | The sender of the mails. |
| `SESSION_DAYS` | `30` | A session ends this many days after the sign-in at the latest. Daily use does not move this end. The cookie ends at the same time. |
| `SESSION_IDLE_DAYS` | `7` | A session also ends this many days after its last use. |
| `MAX_MAPS_PER_OWNER` | `50` | The number of maps of one owner: a user or a team. |
| `MAX_TEAMS_PER_USER` | `20` | The number of teams in which one user can be an owner. |
| `HANDLE_HOLD_DAYS` | `180` | A handle that a team or an account frees stays blocked for this many days (section "Accounts"). `0` turns the hold off. |
| `RATE_LIMIT_LOGIN_IP` | `20/900` | Login requests per client IP, as count/seconds. Each limit per IP counts an IPv6 client by its /64 network. |
| `RATE_LIMIT_LOGIN_ACCOUNT` | `10/900` | Login requests per e-mail address. Password changes and account deletes count here too. |
| `RATE_LIMIT_REGISTER_IP` | `10/3600` | Registrations per client IP. |
| `RATE_LIMIT_REGISTER_ACCOUNT` | `3/3600` | Registrations per e-mail address that send a mail: the confirmation for a new address, the notice for a known one. A new and a known address get the same answers. A registration that fails before its mail, for example with a taken handle, does not count. |
| `RATE_LIMIT_RESET_IP` | `10/3600` | Password reset requests per client IP. |
| `RATE_LIMIT_RESET_ACCOUNT` | `3/3600` | Password reset requests per e-mail address. |
| `RATE_LIMIT_INVITE_USER` | `20/3600` | Invitations that one user sends. |
| `RATE_LIMIT_INVITE_EMAIL` | `3/3600` | Invitations to one e-mail address. |
| `RATE_LIMIT_PASSWORD_CHECK_IP` | `600/600` | Requests of the strength meter per client IP. The meter asks once after each pause in the typing. |
| `PAGE_FILE` | `/srv/site/server-map.html` | The page that the app sends for a map. Compose mounts `SITE_ROOT` at `/srv/site`. |
| `START_FILE` | `/srv/site/index.html` | The start page that the app sends at `/`. If the file is missing, `/` sends the browser to `/account`. |
| `DB_POOL_MIN`, `DB_POOL_MAX` | `1`, `10` | The size of the connection pool. |
| `RUN_MIGRATIONS` | `1` | `0` stops the app from running the migrations at its start. |

### Compose and proxy

| Variable | Local value | Meaning |
|---|---|---|
| `COMPOSE_PROFILES` | `local` | `local` starts mailpit. Remove it on a server. |
| `POSTGRES_DB`, `POSTGRES_USER` | `skillmap` | The database and the admin role of PostgreSQL. `db-setup`, the tests and `backup.sh` use the admin role. The app does not. |
| `POSTGRES_PASSWORD` | none, required | The password of the admin role. |
| `POSTGRES_APP_USER` | `skillmap_app` | The role of the app, without admin rights. `db-setup` creates it, and the role owns the database (section "Database roles"). |
| `POSTGRES_APP_PASSWORD` | empty | The password of the role of the app. Empty means that `db-setup` makes a random password once and keeps it in the volume `db_app_password`. A value in `server/.env` wins. It must differ from `POSTGRES_PASSWORD`, or `db-setup` stops (section "Database roles"). |
| `SITE_ADDRESS` | `it-skills.localhost` | The main domain for Caddy. |
| `USER_SITE_ADDRESS` | `*.it-skills.localhost` | The wildcard of the subdomains for Caddy. |
| `USER_SITES` | `users.caddy` | `none.caddy` turns the subdomains off in the proxy. |
| `WWW_REDIRECT` | `off` | Only with `USER_SITES=none.caddy`: `on` sends every path of `www.<domain>` to the same path on `BASE_URL` with 308. It needs a DNS record for `www.<domain>`, and the proxy gets a certificate for that name (section "Subdomains"). |
| `TLS_MODE` | `internal` | `internal` (local CA), `acme` (public certificate, no wildcard) or `dns` (public wildcard certificate). |
| `ACME_EMAIL` | empty | The e-mail address for the certificate authority. Required for `acme` and `dns`. |
| `DNS_PROVIDER`, `DNS_API_TOKEN` | empty | The DNS module of Caddy and its token, for `TLS_MODE=dns`. |
| `BIND_ADDRESS` | `127.0.0.1` | The IPv4 address that the proxy listens on. Use `0.0.0.0` on a server. |
| `BIND_ADDRESS_V6`, `NETWORK_SUBNET_V6` | `::`, `fd00:10:213:97::/64` | Only with `compose.ipv6.yaml`: the IPv6 address that the proxy listens on, and the IPv6 subnet of the network of the stack (section "IPv6"). |
| `PROXY_IMAGE` | `caddy:2.11.7-alpine` | The image of the proxy. Set it to a Caddy image with the DNS module of the DNS provider for `TLS_MODE=dns`. |
| `HTTP_PORT`, `HTTPS_PORT` | `8080`, `8443` | The ports of the proxy on the host. Caddy listens on the same ports inside its container, so that its header for HTTP/3 names the port of the host. Compose publishes `HTTPS_PORT` on TCP and on UDP, for HTTP/3. Use `80` and `443` on a server. |
| `SITE_ROOT` | `../dist/selfhost` | The site, built with `npm run build:selfhost`. The path is relative to `server/`. |
| `NETWORK_SUBNET`, `PROXY_IP` | `10.213.97.0/24`, `10.213.97.10` | The network of the stack and the fixed address of the proxy. If the subnet is in use, change both. |
| `MAILPIT_PORT` | `8025` | The port of the mailpit page on 127.0.0.1. |

## What the server does

### Accounts

- A user registers with an e-mail address, a password and a handle. The handle is the public name in `/<handle>` and in `<handle>.<BASE_DOMAIN>`.
- An e-mail address has at most 254 characters: a local part of 1 to 64 characters, "@" and a domain with at least one dot. A mail header reads `,` and `;` as the end of an address, and `<`, `>`, `(`, `)`, `[`, `]`, `\` and `"` as quotes or comments. So an address holds none of them, no white space and no control character, and it always names exactly one mailbox. Capitals become small letters.
- A handle has 3 to 30 characters: a to z, 0 to 9 and "-". It cannot start or end with "-" or hold "--", because it is also a DNS label. Capitals become small letters. Some names are reserved: `www`, `api`, `app`, `mail`, `admin`, `static`, `assets`, `vendor`, `example`, `index`, `embed`, `account` and more. `app/security.py` holds the list. It holds every top-level name of the site and of the app, because `/<handle>` shares the top-level paths with them.
- A password has 12 to 1024 characters and at least 4 different characters. It is not the e-mail address, its local part or the handle. There are no rules for types of characters: symbols, digits and capitals are free.
- A password also needs the top score 4 of the strength check zxcvbn (`app/strength.py`). zxcvbn estimates how many guesses an attacker needs, from lists of common passwords, words and names, keyboard rows, repeats, sequences and dates. The server adds German words and names to its English lists (`app/zxcvbn-de/`). It also counts the e-mail address, the handle and the names of the site as known words. So "123456789012!", "myPassword1!" and "Sommer2026!!" fail, and a long sentence passes without a symbol. zxcvbn rates only the first 72 characters, because its search grows fast with the length.
- The strength meter below each new password on the account page asks `POST /api/auth/password-check`. That route applies the same rule and stores nothing, so the meter and the answer of the form always agree. It counts against `RATE_LIMIT_PASSWORD_CHECK_IP`.
- The server stores passwords as Argon2id hashes with a salt per user. It normalizes a password to Unicode NFKC first, so the same password from two keyboards gives the same hash.
- Double opt-in: an account works only after the user opens the link in the confirmation mail and enters the password of the registration. So only a person who holds both the mailbox and the password confirms an account. A wrong password keeps the link valid, and each try counts against `RATE_LIMIT_LOGIN_IP`. The link is valid for 48 hours. If nobody confirms an account for 7 days, the next registration deletes it and frees its handle.
- A password reset link is valid for one hour and works once. A reset ends every session of the user.
- A password change ends every other session. The current browser gets a new session id.
- Deleting an account needs the password. It deletes the user, the sessions, the memberships, the maps, the documents and the share links. A team in which the user is the only member goes too, with its maps. If the user is the only owner of a team with other members, the delete stops with `409 last_owner`. The delete locks the row of the user and then every team in which the user is an owner. So two owners who delete their accounts at the same moment cannot leave a team without an owner. A new team at the same moment goes with the account.
- `GET /api/account/export` gives a ZIP file with one map file per map and `account.json`.
- A freed handle stays blocked for `HANDLE_HOLD_DAYS`, 180 days by default. A handle is also a public address: `/<handle>` and `/<handle>/<slug>`, the embed view `/e/<handle>/<slug>` in frames on other sites, and the subdomain. So no stranger can take over the old addresses of another owner. A team rename, a team delete and an account delete free a handle, also the handles of the teams that go with an account. During the hold, a registration, a new team and a team rename get `409 handle_taken`, the same answer as for a taken handle. The owner that freed a handle can take it back, for example a team that renames back. An account that nobody confirmed never had a public page, so its handle is free at once. The table `freed_handles` keeps the holds (migration `0005_freed_handles`). The server deletes a row when its hold ends.

### The languages

The server speaks English and German. Its texts are in catalogs, one folder per language: `app/i18n/en/` and `app/i18n/de/`. They have the format of the catalogs of the pages, and `i18n/README.md` describes it. `npm run check:texts` checks both folders.

- `errors.json` holds the text of each error code. An error answer sends the code, the English text as `message` and the values of the text as `params` (`API.md`). The pages show the text of the code in their own language, so the build of the site writes these texts into `assets/i18n.js`.
- `mail.json` holds the subjects and the texts of the mails, and the names of the team roles in an invitation.
- `content.json` holds the texts that the server writes into a map: the title of an imported map without a title.
- `app/texts.py` reads the catalogs once, at the start. `text(language, key, **values)` gives a text with its values. A language without a catalog and a key that the language lacks take English. A key that English lacks raises an error, and the tests find it.
- A text with a plural has the forms `one` and `other`, and the value `count` picks the form. The pages use the rules of `Intl.PluralRules`. The server has its own small table, `PLURALS` in `app/texts.py`, with one rule for each of its languages. That is its limit: a language with other forms than `one` and `other`, for example Polish, needs its rule in the table. The server does not start with a catalog of a language that has no rule.

Each account has a language, `en` by default (migration `0004_language`). A registration names it, and `PATCH /api/account` changes it. The data block of each page of the app names it, so the page shows that language. A choice on a static page of the site reaches the account on the next page of the app (`i18n/README.md`). Each mail goes out in the language of its recipient:

| Mail | Language |
|---|---|
| The confirmation of a registration, with its link | The language of the registration |
| A registration with an address that has an account | The language of the account |
| The link for a new password, and a new confirmation link for an account that nobody confirmed | The language of the account |
| An invitation | The language of the confirmed account with that address. Without such an account, the language of the person who invites |

The small pages that the app makes itself are the page of an error, the list of the public maps of an owner, the answer of an embed address without a map, and the map page of a server without `PAGE_FILE`. Their markup holds the English text and the key of each text in `data-i18n` (`i18n/<language>/server.json`, or the text of an error code). Each loads `/assets/i18n.js`, which shows the texts in the language of the browser. A text with values, such as the error `too_many_maps`, stays English on such a page, because `data-i18n` carries no values.

A new language of the server is one folder `app/i18n/<code>/` with the files of English, beside the folder `i18n/<code>/` of the pages, and its rule in `PLURALS`. `npm run check:texts` fails if the pages and the server have other languages.

### Sessions and requests

- Sessions are rows in PostgreSQL. The cookie holds a random id of 256 bits. The table holds only its SHA-256 hash.
- The cookie is `__Host-session` with `HttpOnly; Secure; SameSite=Lax; Path=/`. The prefix `__Host-` makes the browser refuse the cookie without `Secure` or with a `Domain`. With `APP_ENV=local`, the cookie is `session` without `Secure`.
- Each login creates a new session id and deletes the session that the browser sent with the login.
- A session has two ends, as `selfhost/STUDY.md` asks. It ends `SESSION_DAYS` (30) after the sign-in at the latest. Daily use does not move this end. It also ends `SESSION_IDLE_DAYS` (7) after its last use. The server notes a use at most once an hour, so the second end can come up to one hour early.
- The cookie ends at the first end: its `Max-Age` is the time that is left until then. A use moves only the second end, so no answer sets the cookie again. A user signs in again after 30 days at the latest.
- Every POST, PUT, PATCH and DELETE needs the header `X-Requested-With: it-skills` and an `Origin` header equal to `BASE_URL`. Other requests get 403.
- Login, registration and password reset have rate limits per client IP and per e-mail address. The counters are in PostgreSQL. If the request comes from an address in `TRUSTED_PROXIES`, the app takes the client IP from `X-Forwarded-For`. Otherwise it uses the address of the connection.
- One host often owns a whole IPv6 /64 network, so each limit per IP counts an IPv6 client by its /64. An IPv4 client counts by its address, also as an IPv4-mapped IPv6 address.
- Each registration of an address sends a mail to it, so `RATE_LIMIT_REGISTER_ACCOUNT` limits them per address. A known and a new address count in the same way and get the same answers, also at the limit.
- The app writes no access log, because such a log keeps IP addresses and the tokens of share links.
- An error that no route handles gets `500` with the error `internal`, in the JSON format of the API. The connection stays open for the next request.
- No other site can frame a page of the app or a file of the site, so that nobody tricks a user into clicks. Only the embed view of a map allows it (see "Framing rules").
- The answers do not show whether an e-mail address has an account. A registration with a known address sends a notice to that address and gives the same answer as a new one. A failed login gives the same answer for a wrong password and an unknown address, and it takes the same time.

### Maps

- A map is a document store, as the page interface expects: collections of documents, each document a JSON object.
- Collection names match `^[a-z][a-z0-9_-]{0,40}$`. A document id has 1 to 200 characters, no "/" and no control characters. The ids ".", ".." and `__proto__` are not allowed, and `areas`, `stations` and `groups` have stricter rules. A title has 120 characters at most. The site applies the same rules (`selfhost/FORMAT.md`), so a map file that one side takes, the other side takes too.
- A document can have 256 KB at most, as compact JSON in UTF-8. A map can have 4 MB at most.
- Every write raises the version of the map by one. A read of the documents takes the version and the documents from one snapshot of the database. A reader polls with `?since=<version>`. If nothing changed, the reader gets 304. Otherwise it gets only the changed and the deleted documents.
- A write can send `?base=<version>`: the version that the writer knows the document from. If the document changed after that version, the server refuses the write with 409 `conflict` and keeps its state. So a second tab cannot undo a change that it never saw.
- A map is `private`, `link` (shared by link) or `public`. A map has one read link at most. Its token has 192 random bits. The server stores the token and its SHA-256 hash. A reader finds the link by the hash, and the owner sees the link with its creation date at any time and copies it again. A request for the link gives the link that the map has. To revoke the link, the owner makes a new one ("Revoke and generate new link", `{"replace": true}`). The old token stops working at once, also in frames on other sites. A link works only while the map is `link` or `public`, so a private map pauses its link. The unique index on `share_links.map_id` keeps one link per map. A later migration can add a mode, such as an edit link, to that index.
- A public map is at `/<handle>/<slug>`, and with a wildcard also at `https://<handle>.<BASE_DOMAIN>/<slug>`. `/<handle>` and the root of the subdomain list the public maps of the user. An owner without a public map gets the 404 page of an unknown handle there, so the address does not tell who has an account. Only the owner and the members of a team see the empty list.
- The owner of a map (the right to share) can make it the start map in "Share". Then `/<handle>` and the root of the subdomain show that map instead of the list, while the map is public. An owner has one start map (`owners.start_map_id`, migration `0007_start_map.sql`). A map that is not public can be the start map already. Its address shows the list until the map is public. A move into a team and a delete of the map end the start map.
- A change of the start map, a move and a delete of a map write or clear the start map of the owner. So they lock the row of the owner before the row of the map.
- Export and import use the map file of the context, format `it-skills-map`, schema 1. An import always creates a new private map.
- A new map, an import and a move into a team lock the row of the owner before they count its maps. Three requests make a user an owner of a team: a new team, an accepted invitation with the role owner, and a new role owner. Each locks the row of the user before it counts the teams of the user. So parallel requests count one after the other and stop exactly at `MAX_MAPS_PER_OWNER` and `MAX_TEAMS_PER_USER`. Parallel new maps with one title get distinct slugs. Each transaction locks the row of an owner before the row of a map. So no two requests wait for each other in a circle.

`API.md` describes every endpoint.

### Teams (stage c)

A team is an organization. The German page calls it "Team".

- A signed-in user creates a team with a name and a handle. The user becomes its first owner.
- A team name has 1 to 100 characters. The name goes into the subject of every invitation mail, so it holds no line break and no hidden character. The hidden characters are the Unicode categories Cc, Cf, Zl, Zp and Cs. Cc holds the control characters, and Cf the format characters, such as a zero-width space. Zl and Zp are the line and paragraph separators, and Cs holds the halves of UTF-16 pairs.
- Teams and users share one handle namespace. A team handle has the rules and the reserved list of a user handle, because it is also a top-level path and a subdomain. A user cannot register with the handle of a team, and a team cannot take the handle of a user.
- An owner renames the team. A new handle changes the addresses of its public maps. Share links keep working. The old handle stays blocked for other owners for `HANDLE_HOLD_DAYS`, and the team can take it back.
- An owner deletes the team with the password. The delete removes the members, the invitations, the maps, their documents and their share links.

Each member has one of three roles:

| Role | German | What the member can do |
|---|---|---|
| `owner` | Inhaber | Everything below, and manage the team: members, roles, invitations, visibility, share links, the embed setting, name, handle, delete |
| `editor` | Bearbeiter | Create, import, edit, rename and delete maps of the team. Move an own map into the team. No sharing, no members |
| `reader` | Leser | Read every map of the team, also the private ones, and export it |

- A team always keeps at least one owner. The last owner cannot step down, leave or be removed (`409 last_owner`). The server locks the row of the team for every change of the members, so two owners cannot remove each other at the same moment.
- A user can be an owner of `MAX_TEAMS_PER_USER` teams, 20 by default. Each team holds a public handle and its own quota of maps. Without the limit, one account gets any number of names and any multiple of the quota of maps. A new team, an accepted invitation with the role owner, and a change of a role to owner get `409 too_many_teams` at the limit. The teams of the new owner count, not the teams of the owner who gives the role.
- The order of the locks: first the row of a user, then the row of the team, then the rows of its invitations and members. A new invitation and an accepted invitation lock the row of the team first. The delete of a team locks it before its delete reaches the invitations. So such requests at the same moment run one after the other, and none of them gets an error from a deadlock.
- Every member can leave the team, except the last owner.
- An owner invites by e-mail with a role. The mail holds a link to `/account#invite=<token>`. The token has 256 random bits. The server stores only its SHA-256 hash. The link is valid for 7 days and works once. A new invitation to the same address replaces the open one.
- The invited person opens the link. The page shows the team and the role first. The person signs in with any account, or registers, and accepts. The e-mail address of the account does not have to match.
- The owner sees the open invitations and withdraws each one.
- Invitations have rate limits per sending user and per e-mail address. The answer to an invitation is the same for an address with an account and an address without one.

Maps of a team:

- The owner of a map is a user or a team. The table `maps` points to `owners` for both.
- A public map of a team is at `/<team-handle>/<slug>` and at `https://<team-handle>.<BASE_DOMAIN>/<slug>`. `/<team-handle>` lists its public maps with the name of the team. Or it shows the start map that an owner of the team picks.
- A user moves an own map into a team in which the user is an owner or an editor. The map keeps its documents. If the team has the slug, the map gets "-2". The map always arrives private, also when an owner of the team moves it: its share links are deleted, and embedding is off (`embed.allow` is `origins` with an empty list). So a move is no way around the share right, which only an owner of the team has. The owner of the team can share the map again.
- `GET /api/maps/{id}/access` gives `canWrite` and the role. The page of a member is the owner page. Its script has `canWrite` (the right to write), `role` and `canShare` (the right to share). The runtime reads these values and derives no right from the role.
- The embed view of a public map of a team is at `/e/<team-handle>/<slug>`. A share link of a map of a team also has an embed view at `/e/s/<token>`.

### Access decisions

Every access decision goes through one function: `allowed(action, role, visibility)` in `app/access.py`. The table `RULES` in that file lists the roles for each action, for example `map.write` or `team.manage`. The routes get a map only through `map_for()` or `map_at()`, and a team only through `team_for()`. These functions read the role of the visitor in the same query and call `allowed()`. No route checks a role itself.

- A visitor who may not read a map gets `404`. So nobody learns that a private map exists.
- A member who reads a map but lacks the role for an action gets `403 forbidden`.
- A visitor without a role gets `404` for every action that is no read, also on a public map, as in stage b.

### Tables and migrations

The runner in `app/migrate.py` applies each file in `migrations/` once in name order and records it in `schema_migrations`. Each file runs in its own transaction.

- `0001_initial.sql` (stage b) creates owners, users, tokens, sessions, maps, documents, share links and rate limits.
- `0002_embed.sql` (stage b) adds the embed setting to each map: the columns `embed_allow` and `embed_origins`.
- `0003_teams.sql` (stage c) allows the owner kind `organization` and adds the tables `organizations`, `memberships` and `invitations`. It changes no row of stage b. The app runs it at its next start, so a stage b database migrates without a manual step.
- `0004_language.sql` adds the language of each account: the column `language` of `users`, `en` by default. Every account of the time before gets English. The check of the column keeps only the form of a language code. The app accepts only the languages of its catalogs.
- `0005_freed_handles.sql` adds the table `freed_handles`. It holds each handle that a team rename, a team delete or an account delete freed, with its owner and the time. It changes no row.
- `0006_one_share_link.sql` keeps one read link per map. It adds the column `token` to `share_links` and a unique index on `map_id`. It deletes every link without a stored token. Before this file the server kept only the hash of a token, so this deletes every older link. No release had such links, only test stacks. Their owners create a new link. A new database runs every file in name order.

### Database roles

The app connects to PostgreSQL as a role without admin rights, `POSTGRES_APP_USER`. So a fault in the SQL of the app, for example an SQL injection, cannot give an attacker the whole database server. With the admin role, `COPY ... TO PROGRAM` runs any program on that server. The admin role `POSTGRES_USER` of the postgres image stays for `db-setup`, the tests and the backups.

The service `db-setup` runs `db-setup.sql` with `psql` as the admin role at each start of the stack. It runs after `db` is healthy, and `app` starts only after it ends without an error. Each run gives the same result:

- It creates the role `POSTGRES_APP_USER`, or updates it. The role is no superuser, it cannot create a database or a role, and it is a member of no other role.
- It gives the role a password. With `POSTGRES_APP_PASSWORD` in `server/.env`, it takes that value, and a new value reaches the role at the next start. Without it, `db-setup` makes a random password at its first run and keeps it in the volume `db_app_password`. If that volume is lost, the next start makes a new password. The password of the admin role there stops `db-setup` with a message, because the app must not know the password of the admin.
- It writes the password file of the app, `pgpass` in the volume `db_app_password`. Only the user of the app can read it, and the app reads it through `PGPASSFILE`. So the app never gets the password of the admin role, and no password of the app is in its environment.
- It makes the role the owner of the database, of the schema `public`, and of every table, sequence and view in it. The app runs the migrations at its start, so it must own the objects that they change.
- It takes the right `CONNECT` on every other database, for example `postgres` and `template1`, from `PUBLIC`. So the role of the app can connect only to its own database. The admin role is a superuser and keeps its access.
- It sends each value to `psql` as a variable, never as text in the SQL. So a password with quotes works too.

A database of an older version belongs to the admin role. At the first start after the update, `db-setup` gives every object to the role of the app. No other step is necessary. Without `POSTGRES_APP_PASSWORD`, that start also gives the role a new random password. Before, the role had the password of the admin role. `docker compose -f server/compose.yaml logs db-setup` then says "made a new password for the role of the app".

### Container rights

Each service of `compose.yaml` runs with as few rights as its image allows:

- `no-new-privileges`: no process gains a right through a setuid program or a file capability.
- `cap_drop: [ALL]`: no process has a Linux capability, unless its service adds it by name.
- `read_only`: nobody can change the files of the image. Each service writes only to its volumes and to a `tmpfs`, for example `/tmp`.
- A user other than root, where the image allows it.

| Service | User | Added capabilities | Writes to |
|---|---|---|---|
| `db` | `postgres` of the image | none | `db_data`, and a `tmpfs` for the socket |
| `db-setup` | root | `CHOWN` | `db_app_password` |
| `app` | `app` of the image (uid 10001) | none | a `tmpfs` at `/tmp` |
| `proxy-setup` | root | `CHOWN`, `DAC_READ_SEARCH` | `caddy_data` and `caddy_config` |
| `proxy` | uid 10002 | `NET_BIND_SERVICE` | `caddy_data`, `caddy_config` and a `tmpfs` |
| `mailpit` | uid 65534 (`nobody`) | none | a `tmpfs` at `/tmp` |
| `tests` | root | `DAC_READ_SEARCH` | a `tmpfs` at `/tmp` |

- `db-setup` runs as root, because it gives the password file to the user of the app. That needs `CHOWN`.
- The Caddy image has no user of its own. `proxy-setup` gives the volumes of the proxy to uid 10002 before each start of the proxy. A new volume belongs to root, and so do the files of a proxy of an older version, which ran as root. `DAC_READ_SEARCH` lets it walk through the folders of Caddy, which only their owner can open.
- The binary of the Caddy image carries the file capability `NET_BIND_SERVICE`, so that it can bind 80 and 443 as an ordinary user. Linux starts such a binary only with that capability in the bounding set, the limit of the container. So `cap_add` names it, and Caddy runs with this one capability.
- A Caddy image of your own, for example one from `xcaddy`, can lack that file capability. For it, Compose sets `net.ipv4.ip_unprivileged_port_start` to 0 for the proxy, so every user of its container can bind a low port. Docker sets the same value by default since version 20.10.
- The tests read the root certificate of the proxy and the password file of the app. Both belong to the users of those services, so the tests need `DAC_READ_SEARCH`.

`tests/server/deploy.js` checks these rights in `compose.yaml` and in each running container: the user, the capabilities of the main process, `NoNewPrivs`, and a write to the root file system.

## Subdomains

The subdomains are an option of the host, not the common way. A public map is always at the path form `https://<domain>/<handle>/<slug>`, and the start map of its owner at `https://<domain>/<handle>`. The pages of the app lead with the path form, and they name the subdomain form only as a second address. The subdomain form `https://<handle>.<domain>/<slug>` needs three things on the host that runs the backend:

1. A wildcard DNS record. The DNS zone of the domain needs an A record (and an AAAA record for IPv6) for `*.<domain>` that points to the host. The record for the domain itself stays.
2. A wildcard certificate for `*.<domain>`. Certificate authorities issue a wildcard only through the DNS challenge. In that challenge, the proxy writes a TXT record into the DNS zone through the API of the DNS provider. So the DNS provider must have an API, and the proxy needs a token for it.
3. A Caddy image with the DNS module of the DNS provider. The image `caddy:2.11.7-alpine` has no DNS modules. Build one with `xcaddy` and the module from `github.com/caddy-dns/<provider>`:

```
FROM caddy:2.11.7-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/<provider>
FROM caddy:2.11.7-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
```

Then set `TLS_MODE=dns`, `DNS_PROVIDER=<provider>`, `DNS_API_TOKEN=<token>` and `ACME_EMAIL`. Set `PROXY_IMAGE` to the name of that image, so that `compose.yaml` stays as it is (section "TLS with the DNS challenge"). The `tls-dns` snippet in `proxy/Caddyfile` passes the provider and the token as `dns <provider> <token>`. If the module needs other arguments, change that snippet.

No registration step creates a subdomain. The wildcard record and the wildcard certificate cover every handle, and the app reads the handle from the `Host` header. A new user has a subdomain as soon as the account works.

The wildcard also covers names that no handle can have. `proxy/reserved.caddy` lists the reserved names, and the proxy sends every path of such a host to the app. The app sends `www.<domain>` to the same path on `BASE_URL` with 308, unless `BASE_URL` names `www.<domain>` itself. Every other reserved name gets 404, also for the API and the files of the site. Before, `www` and `api` showed the main site, and each write there failed with 403 `csrf`.

Without a wildcard, set `USER_SITES=none.caddy` and `TLS_MODE=acme`. The path form keeps working. You can also leave `BASE_DOMAIN` empty, then the app gives no subdomain addresses in its answers.

Without the wildcard, `www.<domain>` gets no answer. To send it to the main domain, set `WWW_REDIRECT=on`. Then the proxy sends every path of `www.<domain>` to the same path on `BASE_URL` with 308, as the app does under the wildcard. This needs a DNS record for `www.<domain>`, and the proxy gets a certificate for it, as for the main domain. The option is off by default, because without the DNS record the certificate order fails. When `SITE_ADDRESS` is the `www` name itself, leave it off.

## Deploy

This section gives every step to run the stack on a host of your own. The examples use the domain `it-skills.net` and the folder `/srv/skill-map`. Run every command in the root of the repository, unless a step says otherwise.

### What the host needs

- Linux with Docker Engine and the Compose plugin 2.20 or later. For IPv6, Docker Engine 27 or later (section "IPv6"). The stack needs no other program on the host.
- The ports 80 and 443 on TCP, and 443 on UDP for HTTP/3, open from the internet. Only the proxy publishes ports. The database and the app are reachable only inside the network of the stack.
- A domain with DNS records for the host. For the subdomains of the users, the DNS provider needs an API (section "Subdomains").
- A mail server or a mail relay that sends the mails of the app (section "Mail").
- Node 24 for the build of the site, the version of the tests. The build needs no npm package, so `npm install` is not necessary for it. You can also build the site on another computer and copy `dist/selfhost` to the host.

### Get the code

Clone the repository: `git clone https://github.com/JustusTimmerer/skill-map.git /srv/skill-map`.

### First start

1. Build the site: `node build_selfhost.js`. It writes `dist/selfhost`.
2. Copy `server/.env.example` to `server/.env`, and give it the rights of its owner only: `chmod 600 server/.env`. Set these values:
   - `COMPOSE_PROFILES=` (empty, so that mailpit does not start)
   - a long random `POSTGRES_PASSWORD`, for example from `openssl rand -base64 32`. Leave `POSTGRES_APP_PASSWORD` empty, so that `db-setup` makes a password for the app.
   - `BASE_URL=https://it-skills.net`, `BASE_DOMAIN=it-skills.net`, `SITE_ADDRESS=it-skills.net` and `USER_SITE_ADDRESS=*.it-skills.net`
   - `TLS_MODE=dns` with the values of the section "Subdomains", or `TLS_MODE=acme` with `USER_SITES=none.caddy` and an empty `BASE_DOMAIN`
   - `ACME_EMAIL`, `BIND_ADDRESS=0.0.0.0`, `HTTP_PORT=80` and `HTTPS_PORT=443`
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURITY` and `MAIL_FROM` of the mail server (section "Mail")
3. Point the DNS records to the host: an A record for the domain, and for IPv6 an AAAA record (section "IPv6"). With subdomains, add the same records for `*.<domain>`.
4. Start the stack: `docker compose -f server/compose.yaml up -d --build --wait`. With `--wait`, the command waits for each service. When a service does not become healthy, it ends with an error.
5. Check it. `docker compose -f server/compose.yaml ps` shows `db` and `app` as healthy. https://it-skills.net/api/health answers `{"status": "ok"}`. Register an account. The mail with the link of the registration must arrive.
6. Set up the backups (section "Backups").

### Update

1. Back up: `server/backup.sh ~/backups/skill-map`.
2. Get the new code: `git pull`.
3. Build the site: `node build_selfhost.js`.
4. Build and start the new stack: `docker compose -f server/compose.yaml up -d --build --wait`.
5. Check it as in step 5 of "First start". `docker compose -f server/compose.yaml logs app` names each migration that the app applied at its start, for example `INFO skill-map.migrate: applied the migration 0007_start_map`. The last of these lines names the newest migration of the database, for example `INFO skill-map.migrate: the database is up to date: 0007_start_map`.

The build replaces the files of `dist/selfhost` one by one, the pages last, so the stack never serves an empty or half-written site. The stack serves the new files of the site as soon as step 3 ends, while the old app still runs. So do steps 3 and 4 right after each other. If the update has a new migration, you can stop the proxy before step 3 with `docker compose -f server/compose.yaml stop proxy`. Step 4 starts it again.

The browsers of the visitors get the new site at their next visit. Each page asks for its newest version every time. Each script and style has the version of its content in its address, so no browser runs old code with a new page.

The app applies the new migrations at its start, each file in its own transaction. If a migration fails:

- Its transaction rolls back. The database keeps every file before it, and the failed file leaves no change.
- The app stops at its start. Docker starts it again and again, and it never becomes healthy. `up --wait` ends with an error.
- The proxy does not wait for a healthy app. So it keeps running, and it also starts after a stop or a new container. The files of stage a still work. The proxy answers 502 for the API, the account page and the maps of the accounts, and no browser keeps that answer.
- `docker compose -f server/compose.yaml logs app` shows the error.
- To go back, check out the version that ran before (`git checkout <commit>`), and repeat steps 3 and 4. The old app works with the database, because the failed file changed nothing.

If the migrations succeeded and you still go back to an older version, restore the backup of step 1 first (section "Restore"). An older app does not know the newer tables.

### Backups

`server/backup.sh <folder>` backs up the running stack. Each run writes three files with the time in their names:

| File | Content |
|---|---|
| `db-<time>.dump` | The database, as `pg_dump` writes it in its custom format. The script takes the admin role and the database of `server/.env`. |
| `env-<time>` | `server/.env` with its secrets. Without it, nobody can open the database of the dump with the old password, and the app lacks every value of its environment. |
| `caddy_data-<time>.tgz` | The volume `caddy_data`: the certificates, the key of the ACME account and the local CA of the proxy. Without it, the proxy asks the certificate authority for new certificates, and the authority allows only a few in a week. |

Each run deletes the files of these kinds that are older than 14 days. `KEEP_DAYS` changes the number. The files hold secrets, password hashes and e-mail addresses, so the script gives the folder the rights of its owner only.

Run it every night with cron, in the crontab of the user who runs Docker: `crontab -e` as that user. The folder of the backups and the log file belong to that user, in its home folder. A folder such as `/var/backups` belongs to root, and cron then cannot even open the log, so the script never runs. Add this line:

```
15 3 * * * /srv/skill-map/server/backup.sh "$HOME/backups/skill-map" >> "$HOME/skill-map-backup.log" 2>&1
```

If the script cannot write its folder, or a step fails, it ends with exit code 1. It then writes a line that starts with `backup.sh: FAILED` to the log and to the system log (`journalctl -t skill-map-backup`). It removes the files of the failed run. Read the log after the first night.

A backup on the same host does not survive the loss of the host. Copy the folder to another place after each run, for example with a second cron line 30 minutes later:

```
45 3 * * * rsync -a --delete "$HOME/backups/skill-map/" backup@backup.example.org:skill-map/
```

If you do not control that place, encrypt the copy, for example with `restic` or `borg`. Test a restore on another computer once, and again after each large update.

### Restore

Use the three files of one backup run. On a new host, first get the code (section "Get the code"). Run each command in the root of the repository. The commands name the files of the backup without a folder, so copy them there or add their folder.

1. Copy `env-<time>` to `server/.env`, with the rights of its owner only: `cp env-<time> server/.env` and `chmod 600 server/.env`. Build the site: `node build_selfhost.js`.
2. Stop the app and the proxy of a running stack. On a new host, nothing runs yet. Then start the database alone. The command with `--wait` waits for a ready database:

```
docker compose -f server/compose.yaml stop app proxy
docker compose -f server/compose.yaml up -d --wait db
```

3. Make the database empty, and load the dump into it:

```
docker compose -f server/compose.yaml exec -T db sh -c 'dropdb -U "$POSTGRES_USER" --if-exists --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose -f server/compose.yaml exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' < db-<time>.dump
```

After this step, the admin role owns the restored objects. At the start in step 5, `db-setup` gives them to the role of the app (section "Database roles"). This also holds for a dump of an older version, in which the admin role owns every object. The dump holds no rights of the role of the app. So the restore also works on a new host, before that role exists.

4. Load the data of the proxy into its volume before the proxy starts. A proxy without its certificates orders new ones at its start, and the certificate authority allows only a few in a week. The first command gives the volumes to the user of the proxy (section "Container rights"). The second command unpacks the backup as that user, in a container of its own, without the server of the proxy. The files of the backup replace the old ones.

```
docker compose -f server/compose.yaml run --rm proxy-setup
docker compose -f server/compose.yaml run --rm --no-deps -T --entrypoint tar proxy -x -z -o -f - -C /data < caddy_data-<time>.tgz
```

5. Start the stack. The command with `--wait` waits for every service. When a service does not become healthy, the command ends with an error:

```
docker compose -f server/compose.yaml up -d --build --wait
```

6. Check it as in step 5 of "First start". If the dump is older than the code, the app applies the newer migrations at its start. On a new host, the volume `db_app_password` is empty, so `db-setup` makes a new password for the role of the app (section "Database roles").

`tests/server/deploy.js` runs the code blocks of these steps as they stand. It restores a backup of a test stack into a new project (section "Run the tests").

### Mail

The app sends each mail to `SMTP_HOST` and does not deliver it itself. Many hosts block the outgoing port 25, so use a relay: the SMTP server of a mail provider or of a mail service.

- A relay on port 587: `SMTP_PORT=587`, `SMTP_SECURITY=starttls`, with `SMTP_USER` and `SMTP_PASSWORD` of the relay.
- A relay on port 465: `SMTP_PORT=465` and `SMTP_SECURITY=tls`.
- The app logs in to the mail server only inside TLS. If `SMTP_USER` is set and `SMTP_SECURITY` is `none`, the app does not start. `docker compose -f server/compose.yaml logs app` then names both settings. With `starttls`, a mail server that offers no STARTTLS stops the mail. The app never sends it in plain text instead.
- A mail server without a login, for example on the host itself, works with `SMTP_SECURITY=none` and an empty `SMTP_USER`.
- `MAIL_FROM` must name an address of a domain for which the relay sends mail, for example `it-skills <no-reply@it-skills.net>`.

The mail servers of the recipients check three DNS records of the domain of `MAIL_FROM`. Without them, the mails of the app often land in the spam folder.

| Record | Name | Value |
|---|---|---|
| SPF | the domain, type TXT | `v=spf1 include:<the SPF domain of the relay> -all`. The relay names its SPF domain. |
| DKIM | `<selector>._domainkey.<domain>`, type TXT or CNAME | The key that the relay gives you. The relay signs each mail with it. |
| DMARC | `_dmarc.<domain>`, type TXT | `v=DMARC1; p=quarantine; rua=mailto:<an address that reads the reports>`. Start with `p=none` for a few days, and read the reports. |

If the host sends the mails itself, through a mail server on the host, the host needs an open port 25. Then the SPF record names the host: `v=spf1 a:<host name> -all`. The provider of the host must also set the reverse DNS of its IP address to that host name.

### TLS with the DNS challenge

The subdomains need a wildcard certificate, and Caddy gets one only through the DNS challenge (section "Subdomains"). The image of the proxy then needs the DNS module of the DNS provider. Build the image on the host, and give it a name:

```
docker build -t skill-map-caddy:2.11.7-<provider> - <<'EOF'
FROM caddy:2.11.7-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/<provider>
FROM caddy:2.11.7-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
EOF
```

Then set `PROXY_IMAGE=skill-map-caddy:2.11.7-<provider>` in `server/.env`, with `TLS_MODE=dns`, `DNS_PROVIDER=<provider>`, `DNS_API_TOKEN` and `ACME_EMAIL`. Do not change `compose.yaml`: Git tracks it, and the next pull then conflicts with your change. After an update of Caddy in `compose.yaml`, build the image again with the new version.

### IPv6

`BIND_ADDRESS` publishes the ports of the proxy on one IPv4 address. For IPv6, add the file `server/compose.ipv6.yaml` to each command that starts containers:

```
docker compose -f server/compose.yaml -f server/compose.ipv6.yaml up -d --build
```

- It publishes the ports on `BIND_ADDRESS_V6` too. The default `::` means every IPv6 address of the host. If the host has several IPv6 addresses, set one of them.
- It gives the network of the stack an IPv6 subnet (`NETWORK_SUBNET_V6`, by default `fd00:10:213:97::/64`). So Docker forwards an IPv6 connection straight to the proxy, and the app sees the address of the visitor. The rate limits per IP then count each visitor on its own, an IPv6 visitor by its /64 network.
- This needs Docker Engine 27 or later. Since version 27, Docker writes the IPv6 rules of the firewall (`ip6tables`) by default. An older Engine needs `"ip6tables": true` in `/etc/docker/daemon.json`, and before version 26 also `"experimental": true`. Without these rules, Docker passes each IPv6 connection through its own proxy process. The proxy of the stack then sees one address of Docker for every IPv6 visitor, and all IPv6 visitors share one rate limit.
- Keep `NETWORK_SUBNET_V6` a unique local subnet (ULA, below `fd00::/8`), as the default is. Docker then translates the addresses of the containers, and it keeps the address of the visitor.
- Add an AAAA record with the IPv6 address of the host for the domain, and for `*.<domain>` with subdomains.
- Check it from another computer: `curl -6 https://it-skills.net/api/health`.

### Logs

Each container writes its output to Docker. `compose.yaml` rotates it: at most 5 files of 10 MB for each container. `docker compose -f server/compose.yaml logs --tail 200 app` shows the last lines of the app. The app writes no access log, because such a log keeps IP addresses and the tokens of share links. The lines of the app itself start with their level and the name `skill-map`: the migrations at its start, a mail that did not go out, and an error that no route handled. The proxy writes only its errors.

### Databases of the old feature branches

The release branch supports databases of its own migrations only. The stacks of the earlier feature branches, for example `feature/selfhost-teams`, named their migrations in another way. The app cannot update such a database. Start such a stack fresh:

1. Download the maps of each account on its account page: "Download all your own maps as a ZIP file". The ZIP file holds one map file for each map. Download each map of a team on its map page with "Export".
2. Remove the stack with its data: `docker compose -f server/compose.yaml down -v`.
3. Start the new stack, and register again. Import each map file with "Import a map file" on the account page.

### A host with Python and PostgreSQL, without Docker

The app is a process that keeps running. A host that runs scripts only as CGI (one process per request) is not enough.

1. Create a PostgreSQL 17 database and a user that owns it. That user is not a superuser and cannot create a database or a role, as `db-setup` makes it for the stack (section "Database roles"). As the admin of PostgreSQL, for example: `createuser --no-superuser --no-createdb --no-createrole --pwprompt skillmap_app`, then `createdb --owner skillmap_app skillmap`. The app needs no other right, because it owns the database and the schema `public`. Then take the right to connect to the other databases from `PUBLIC`, as `db-setup` does: `psql -c 'REVOKE CONNECT ON DATABASE postgres, template1 FROM PUBLIC'`.
2. Install Python 3.13. In `server/`, create a virtual environment and run `pip install --no-deps -r requirements.txt`.
3. Set the environment variables of the app, for example in an environment file of a systemd service. Set `TRUSTED_PROXIES=127.0.0.1`, `PAGE_FILE` to the `server-map.html` of the built site and `START_FILE` to its `index.html`.
4. Start the app with `uvicorn --factory app.main:create_app --host 127.0.0.1 --port 8000 --no-proxy-headers --no-server-header --no-access-log` in `server/`, as the `Dockerfile` does. `--no-access-log` keeps IP addresses and the tokens of share links out of the log. The app also turns off the access log of uvicorn itself. It runs the migrations at its start. `python -m app.migrate` runs them on their own.
5. Put a web server with TLS in front of the app. It serves the files of the built site. It passes `/`, `/index.html`, `/api`, `/s`, `/e` and `/account` to `127.0.0.1:8000`. It also passes every path of the form `/<handle>` or `/<handle>/<slug>`, with the pattern `^/[a-z0-9-]+(/[a-z0-9-]+)?/?$`. Such a path has one or two names without a dot, of the characters a to z, 0 to 9 and "-". It can end in "/", and the app then sends the browser to the address without it. For subdomains, it passes `/`, `/<slug>`, `/<handle>/<slug>`, `/api` and `/s` of each `<handle>.<domain>` to the app. It passes every path of a reserved name below the domain to the app too, as `proxy/reserved.caddy` lists them. It sets `X-Forwarded-For` and keeps the `Host` header. It sends the Content-Security-Policy of the site with `base-uri 'none'` and `frame-ancestors 'self'`, as `proxy/Caddyfile` does. With the files of the site, it also sends `X-Frame-Options: SAMEORIGIN` and the cache headers of `selfhost/DEPLOY.md`. It keeps the headers of the app as they are.
6. Back up the database with `pg_dump --format=custom`, the environment file and the certificates of the web server, as in "Backups".

## Files

| Path | Content |
|---|---|
| `app/main.py` | The app factory, the CSRF rule, the limits of the request body, the error format |
| `app/errors.py` | The error of the API: its code, its variant, its values and its English message |
| `app/texts.py` | The catalogs of the server and the plural rule of each language |
| `app/i18n/` | The catalogs of the server: the error texts, the mails and the content, one folder per language |
| `app/mail.py` | The mails, in the language of their recipient, and the SMTP connection |
| `app/accounts.py` | Registration, login, logout, reset, password change, the language, account delete and export |
| `app/maps.py` | The maps, their documents, export, import, share links and the move into a team |
| `app/teams.py` | Teams, members, roles and invitations |
| `app/readers.py` | Read-only routes for public maps and share links |
| `app/pages.py` | The start page, the map page, the embed view, the addresses of the owners, the subdomains and `/account` |
| `app/access.py` | Every access decision: the roles, the table `RULES` and `allowed()` |
| `app/store.py` | The document store and the map file |
| `app/security.py` | Passwords, handles, tokens and the client IP |
| `app/strength.py` | The strength check of a new password with zxcvbn, and the warnings and tips of the strength meter |
| `app/zxcvbn-de/` | The German word lists of the strength check, with their licenses |
| `app/handles.py` | The hold of a freed handle |
| `app/static/` | The account page |
| `migrations/` | SQL migrations |
| `db-setup.sql` | The role of the app and its database, for the service `db-setup` |
| `proxy/` | The Caddy configuration. `reserved.caddy` lists the reserved names below the domain. `www-on.caddy` is the option `WWW_REDIRECT=on`. |
| `compose.ipv6.yaml` | The ports and the network of the stack for IPv6 |
| `backup.sh` | The backup of the database, of `server/.env` and of the volume `caddy_data` |
| `tests/` | The pytest tests and the sample map file |
| `../selfhost/runtime/server.js` | The runtime of the map page on the server, with the dialog "Share" |
| `../selfhost/site/embed.js` | The compact reader of the embed view |
| `../selfhost/site/account.js` | The card "Save with an account" of the start page |
| `../tests/server/run.js` | The browser tests of stage b |
| `../tests/server/deploy.js` | The tests of the deploy: the rights of the containers, HTTP/3, the backup and the restore, and the lines of `selfhost/DEPLOY.md` |
