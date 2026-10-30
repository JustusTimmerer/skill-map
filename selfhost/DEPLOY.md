# Deploy the self-hosted site

The site is static files. It needs no program on the server, no database and no cookies. Each visitor keeps his maps in his own browser.

The same build also serves stage b, the site with accounts. Then the stack in `server/` serves it, together with the API, the account page and the maps of the accounts. The section "With accounts (stage b)" at the end tells how.

## Get the code

Clone the repository from https://github.com/JustusTimmerer/skill-map.

## Build

You need Node 24, the version of the tests. The build needs no npm package, so `npm install` is not necessary for it. In the root of the repository, run:

```
node build_selfhost.js
```

`npm run build:selfhost` runs the same command. The build writes the site to `dist/selfhost/`. It first makes every file in a folder next to it. Then it moves each file into place, the pages last, and it deletes the files that the new build lacks. So a web server that serves `dist/selfhost/` never finds the folder empty or a file half written. To look at it before the upload, run `npm run serve:selfhost`, and then open the address `http://127.0.0.1:8080/`. Do not open `index.html` straight from the disk, because browsers treat the storage and the security rules of local files differently.

## Build a public demo with made-up data

The example map of the start page is a real map. To publish a demo, build the site with the fictional map of `selfhost/site/demo.it-skills-map.json`. It has the areas, categories and skills of the real map, and made-up employers, projects and a made-up name. Run:

```
SKILLMAP_EXAMPLE=selfhost/site/demo.it-skills-map.json node build_selfhost.js dist/demo
```

Upload the files of `dist/demo/` as described below. `node save_demo.js` writes the demo file again from the example map.

## Fill in the legal pages

The imprint and the privacy notice hold placeholders in square brackets. Copy `selfhost/site/legal.example.json` to a file outside the repository, fill in your details, and build with it. Each key fills its placeholder in German and English. When no placeholder is left, the draft note goes away.

```
SKILLMAP_LEGAL=/path/to/legal.json SKILLMAP_EXAMPLE=selfhost/site/demo.it-skills-map.json node build_selfhost.js dist/demo
```

The hosting provider and the contract on commissioned processing are facts that you must check. Have a lawyer or a data protection officer read both pages once before you publish them.

## One folder for the upload

`node make_upload.js <folder>` builds the demo into one folder and adds the `.htaccess` for Apache. Use it for each upload, because a build deletes files that it does not know. The options are `--legal legal.json` (see above), `--site https://example.org` (the address in `llms.txt`) and `--example map.json` (another example map).

```
node make_upload.js C:/Users/justu/skill-map-upload --legal C:/Users/justu/skill-map-legal.json --site https://www.it-skills.net
```

## Upload

1. Copy everything inside `dist/selfhost/` to the web space, for example with SFTP. Keep the folders `assets/` and `vendor/` as they are.
2. Point the domain, for example it-skills.net, to the folder that holds `index.html`. Every link of the site is relative, so a subfolder works too.
3. Open the domain with HTTPS and check the start page, the example map and a new map.

After an update, build again and copy all files again. Copy `assets/` and `vendor/` first and the `.html` files last, so that no new page waits for a file that is not there yet. Then delete the files that the new build no longer has. With `rsync` over SSH, two commands do this:

```
rsync -a --exclude '*.html' dist/selfhost/ user@host:/www/it-skills/
rsync -a --delete dist/selfhost/ user@host:/www/it-skills/
```

The maps of the visitors stay in their browsers. They belong to the origin: the scheme, the domain and the port. If the site moves to another domain, the visitors do not see their maps there. They export each map on the old domain and open the file on the new one.

## Content types

| Files | Content type |
|---|---|
| `*.html` | `text/html; charset=utf-8` |
| `*.js` | `text/javascript; charset=utf-8` |
| `*.css` | `text/css; charset=utf-8` |
| `*.svg` | `image/svg+xml` |
| `*.woff2` | `font/woff2` |
| `*.ttf` | `font/ttf`, the font of the PDF download |
| `*.json` | `application/json` |
| `*.txt` | `text/plain; charset=utf-8` |

## Cache headers

The build gives each address of a script, a style, a font and the icon a version: the start of the SHA-256 of the content of the file, as in `assets/page.js?v=bfcab686153b`. A new content gets a new address. So a browser can keep such an address for ever, and it never runs old page code with a new page.

| Address | Header | Reason |
|---|---|---|
| An address with `?v=` | `Cache-Control: public, max-age=31536000, immutable` | Its content never changes. |
| Every other file, the `.html` pages too | `Cache-Control: no-cache` | The browser asks again on each use. When the file did not change, the web server answers `304 Not Modified`. So a new build reaches the visitors at the next visit. |
| An error, for example `404 Not Found` | `Cache-Control: no-store` | During an upload, a page can ask for a file that is not there yet. The browser must not keep that error, above all not for a year. |

The stack of stage b sends these headers itself (`server/proxy/Caddyfile`).

## Recommended headers

Each page holds its Content Security Policy as a meta tag. The pages run no inline script, so the policy allows only the scripts of the site. `style-src` keeps `'unsafe-inline'`, because the map page writes `style` attributes. Send the policy as a header too. Only a header can hold the rule `frame-ancestors 'self'`, which stops other sites from showing the pages in a frame. `X-Frame-Options` says the same to older browsers. The stack of stage b sends the same headers (`server/proxy/Caddyfile`), and `server/tests/test_stack.py` compares each copy of the policy:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'
X-Frame-Options: SAMEORIGIN
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

For Apache 2.4, put this in a `.htaccess` file next to `index.html`. The web space must allow such a file, and Apache needs the module `mod_headers`. `AddCharset` names UTF-8 in the content type of the pages, scripts, styles and texts. `Header always` sends a header with an error page too.

```
Header set Cache-Control "no-cache"
<If "%{QUERY_STRING} =~ /(^|&)v=[0-9a-f]+(&|$)/">
  Header set Cache-Control "public, max-age=31536000, immutable"
</If>
Header always set Cache-Control "no-store" "expr=%{REQUEST_STATUS} >= 400"
AddType font/woff2 .woff2
AddType font/ttf .ttf
AddCharset utf-8 .html .js .css .txt
Header always set Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'"
Header always set X-Frame-Options "SAMEORIGIN"
Header always set X-Content-Type-Options "nosniff"
Header always set Referrer-Policy "no-referrer"
```

For nginx, put the `map` block into the `http` block, and the rest into the `server` block of the site. The `map` block picks the cache rule from the status and the version of each answer. A `types` block replaces the whole list of content types of its block. Without that list, nginx sends each page, script and style as `application/octet-stream`. With `nosniff`, the browser then downloads the pages instead of showing them, and it runs no script. So the `server` block first loads the standard list `mime.types` of nginx, and then the `types` block adds `woff2` and `ttf` to it. `charset` names UTF-8 in the content type of the pages, and `charset_types` adds the scripts, the styles and the texts:

```
map "$status $arg_v" $site_cache {
  "~^(200|206|304) $" "no-cache";
  "~^(200|206|304) ." "public, max-age=31536000, immutable";
  default             "no-store";
}

server {
  # ...
  include mime.types;
  types { font/woff2 woff2; font/ttf ttf; }
  charset utf-8;
  charset_types text/css text/javascript application/javascript text/plain;
  add_header Cache-Control $site_cache always;
  add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'" always;
  add_header X-Frame-Options SAMEORIGIN always;
  add_header X-Content-Type-Options nosniff always;
  add_header Referrer-Policy no-referrer always;
}
```

Newer versions of nginx have `woff2` and `ttf` in `mime.types` already. Then `nginx -t` warns about a duplicate extension. The warning does no harm. Check the content types after each change of the configuration, for example with `curl -sI https://it-skills.net/assets/site.css`. The answer must name `text/css; charset=utf-8`, not `application/octet-stream`. `tests/server/deploy.js` serves the site with these lines in real nginx and Apache containers and checks each header (`server/README.md`, "Run the tests").

## Before the site goes public

- Fill the placeholders [NAME], [ANSCHRIFT] and [E-MAIL] in `selfhost/site/imprint.html` and `selfhost/site/privacy.html`, and [NAME], [ADDRESS] and [E-MAIL] in their English versions. Both pages are drafts and say so at the top. Each page holds the German text, which is the binding one, and its English translation. The page shows the German text in German and the English text in every other language.
- Check what the web server logs for each request, and add it to the privacy page.
- Remove the draft mark only after this check.

## With accounts (stage b)

The build writes two files that only the server uses:

| File | Use |
|---|---|
| `server-map.html` | The map page of a map in an account. The app of `server/` sends it for `/<handle>/<slug>`, for the start map at `/<handle>` and for `/s/<token>`, with the runtime `assets/runtime-server.js`. |
| `assets/account.js` | The card "Save with an account" of the start page. |

A plain web space never runs them. `server-map.html` shows only a message there, and `assets/account.js` does nothing. A web space without the server does not need these two files.

On the server, one stack serves everything. Compose mounts `dist/selfhost` into the proxy and into the app:

- The proxy sends the files of the site: `map.html` and `example.html` of stage a, `assets/`, `vendor/` and the legal pages. It sends the Content Security Policy of the site and the cache headers of this file as headers (`server/proxy/Caddyfile`).
- The app sends the start page at `/` and `/index.html`. It adds the account of the browser, so the start page shows both ways: "Without an account, in the browser" and "Save with an account". The app sends the same policy as a header for each of its pages, with `base-uri 'self'`. The reason: it adds `<base href="/">` to the pages that it sends.
- The app answers the API at `/api`, the account page at `/account`, and the maps at `/<handle>/<slug>` and `/s/<token>`. `/<handle>` shows the start map of the owner or the list of its public maps. On a host with subdomains, a map is also at `https://<handle>.<domain>/<slug>`.
- A handle shares the top-level paths with the site. So a new top-level page or folder of the site needs its name in the reserved list of the server, or the build stops (`server/README.md`).

A visitor without an account uses the site as in stage a, and his maps stay in his browser. A signed-in visitor also sees the maps of the account on the start page. He can move a map of the browser into the account with "Copy to the account".

The section "Deploy" in `server/README.md` gives every step on a host of your own: the first start, an update, the backups and the restore, the mail, the certificates, IPv6 and the logs. After a new build, the stack shows the new files at once. IPv6 needs Docker Engine 27 or later and an IPv6 subnet of the kind ULA (`fd00::/8`) for the network of the stack. Without them, the proxy sees one address for every IPv6 visitor, and all of them share one rate limit (`server/README.md`, "IPv6").

The privacy page of stage a says that the site sets no cookie. With accounts, the account page sets the session cookie after the login, and the server stores the e-mail address and the maps. Add these facts to the privacy page before stage b goes public.
