"""HTML pages of the app: the start page, the map page for owners and readers, the address of an owner, the
subdomains <handle>.<BASE_DOMAIN>, and the account page /account.

The addresses are paths below the main domain (his answer of 2026-10-19 to finding A5 of the final review):
<BASE_URL>/<handle>/<slug> is a map, and <BASE_URL>/<handle> is the address of an owner, a user or a team. That address
shows the start map of the owner while it is public (owners.start_map_id, migration 0007_start_map), and else the list
of the public maps of the owner. A handle shares the top-level paths with the site and the app, so every top-level name
of both is reserved (security.RESERVED, checked by build_selfhost.js). The subdomains are an option of the host: "/" of
<handle>.<BASE_DOMAIN> is the address of the owner, and "/<slug>" a map of the owner.

The map page is a static page of the site (PAGE_FILE, server-map.html of the build). The app adds one data block before
everything else: <script type="application/json" id="it-skills-server"> with {mode, api, canWrite, map, account,
language}. It is JSON and no script, because the policy of the site runs no inline script. The runtime of the site reads it into
window.IT_SKILLS_SERVER (selfhost/runtime/local.js). The runtime of the page (selfhost/runtime/server.js) reads
documents from api + "/docs"; a visitor with canWrite writes to api + "/docs/<collection>/<id>". The runtime takes write
access only from canWrite: from this data block and from each answer of api + "/docs". It never derives it from mode or role.

Mode "owner" means: the visitor has a role for the map (the user of a personal map, or a member of the team
that owns it). Then api is /api/maps/<id>, canWrite follows the right map.write of the role, and the config also has
"role" and "canShare" (the right map.share: visibility, share links and the embed setting).

The start page is the static start page of the site (START_FILE) with the data block {mode: "site", account, user,
language}. With it, the start page also shows the maps of the account (selfhost/site/account.js). The account page
/account (server/app/static/account.html) gets the data block {mode: "account", user, language} in the same way.

language is the language of the signed-in account (users.language), or null without a session. assets/i18n.js shows
the page in it. The embed view never reads the session, so its language is always null.

The app makes a few small pages itself: the page of an error (error_page), the list of the public maps of an owner, the
answer of an embed address without a map, and the map page of a server without PAGE_FILE. Their markup holds the English
text, and data-i18n names the key of each text in the catalogs of the pages (i18n/<language>/server.json, or the error
texts). Each loads /assets/i18n.js, which shows them in the language of the browser (i18n/README.md).

Every HTML answer of the app carries the Content-Security-Policy of the site as a header (site_policy), with the
frame-ancestors of its page. The account page /account keeps its own, stricter policy.

The embed view /e/<handle>/<slug> (a public map) and /e/s/<token> (a share link) is the same map page with mode
"embed": a compact reader for a frame on another site. It finds its map with map_at and shared_map, so it works for
the map of a user and of a team. It is the only page that other sites may frame (Content-Security-Policy:
frame-ancestors, from the embed setting of the map). It never reads the session, so a signed-in owner sees what every
reader sees, and it sets no cookie. Every other answer of the app keeps "frame-ancestors 'self'" (main.py).
"""
from __future__ import annotations

import html
import json
import re
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from starlette.convertors import StringConvertor, register_url_convertor

from .access import allowed, can_write, map_at, public_maps, public_start_map, sees_owner, shared_map
from .errors import ApiError, not_found
from .security import RESERVED, handle_problem
from .sessions import current_user, only_on_own_site, pool_of, settings_of, site_handle
from .store import frame_ancestors


class HandleConvertor(StringConvertor):
    """A path segment that can be a handle: the form of security.HANDLE_RE, and no reserved name. So /<handle>/<slug>
    never takes a path of the app such as /api/<unknown>, which keeps its 404 for every method, and not 405. The handler
    checks handle_problem() too, for the rules that a pattern does not hold."""
    regex = ("(?!(?:" + "|".join(sorted((re.escape(name) for name in RESERVED), key=len, reverse=True)) + ")(?:/|$))"
             "[a-z0-9][a-z0-9-]{1,28}[a-z0-9]")


register_url_convertor("handle", HandleConvertor())

router = APIRouter()

# The Content-Security-Policy of the site: no page loads from another host, runs an inline script, sends a form or opens a
# frame elsewhere. build_selfhost.js writes the same policy into each page of the site as a meta tag, with base-uri
# 'none', and the proxy sends it as a header for the files of the site (server/proxy/Caddyfile). tests/test_stack.py
# compares the three copies. style-src keeps 'unsafe-inline', because the map page writes style attributes.
SITE_POLICY = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
               "font-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; form-action 'none'")


def site_policy(frame_ancestors: str) -> str:
    """The policy of an HTML answer of the app. base-uri 'self' allows the <base href="/"> that _inject adds."""
    return f"{SITE_POLICY}; base-uri 'self'; frame-ancestors {frame_ancestors}"

STATIC = Path(__file__).parent / "static"
ACCOUNT_FILES = {"account.js": "text/javascript", "account.css": "text/css"}
ACCOUNT_POLICY = {
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; "
                               "form-action 'self'",
    "X-Frame-Options": "DENY",
}
ACCOUNT_HEADERS = {**ACCOUNT_POLICY, "Cache-Control": "no-cache"}
# The script of the texts of the site (assets/i18n.js), the first and only script of each page that the app makes.
TEXTS_SCRIPT = '<script src="/assets/i18n.js" defer></script>'

# The answer of an embed address without a map. Other sites may frame it, so that the frame on their page says why it
# is empty. It says the same for every reason, so that nobody learns whether a private map exists.
EMBED_MISSING = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title data-i18n="server.embedMissing.title">Map not found</title>
{TEXTS_SCRIPT}
<style>body{{margin:0;min-height:100vh;display:grid;place-items:center;font:14px/1.5 system-ui,sans-serif;
background:#f3f6f5;color:#17201e}}@media (prefers-color-scheme: dark){{body{{background:#0f1517;color:#e3ebe9}}}}
p{{margin:1rem;max-width:32rem;text-align:center}}</style></head>
<body><p data-i18n="server.embedMissing.text">Not found. This map does not exist, or it is no longer shared.</p></body></html>"""

# The map page of a server without PAGE_FILE. The paragraph with the link keeps the link: its text replaces only the
# words before it (i18n/README.md).
FALLBACK_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
""" + TEXTS_SCRIPT + """</head>
<body><main style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem">
<h1>{title}</h1><p data-i18n="server.fallback.missing">The page of the map is not installed on this server yet (PAGE_FILE is missing).</p>
<p data-i18n="server.fallback.data">The data is at <a href="{api}/docs">{api}/docs</a>.</p></main></body></html>"""


def error_page(error: ApiError) -> str:
    """The page of an error for a browser: its status and its English text. A text without values also names its key,
    so that assets/i18n.js shows it in the language of the browser. A text with values keeps English, because data-i18n
    carries no values."""
    key = "" if any(name != "variant" for name in error.params) else f' data-i18n="{html.escape(error.key)}"'
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{error.status}</title>{TEXTS_SCRIPT}'
            f'</head><body style="font-family:system-ui,sans-serif;margin:3rem"><h1>{error.status}</h1>'
            f"<p{key}>{html.escape(error.message)}</p></body></html>")


class PageFile:
    """The static page, read again when the file changes."""

    def __init__(self, path: str):
        self.path = Path(path)
        self._cache: tuple | None = None

    def text(self) -> str | None:
        try:
            stat = self.path.stat()
        except OSError:
            return None
        key = (stat.st_mtime_ns, stat.st_size)
        if self._cache is None or self._cache[0] != key:
            # The bytes as they are, so that the app sends the file without a change of its line ends.
            self._cache = (key, self.path.read_bytes().decode("utf-8"))
        return self._cache[1]


ACCOUNT_PAGE = PageFile(str(STATIC / "account.html"))


def _script(config: dict) -> str:
    # A data block that no browser runs. "<" and the two line separators are escaped, so no text of a map ends the block.
    payload = json.dumps(config, ensure_ascii=False)
    payload = payload.replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    return f'<script type="application/json" id="it-skills-server">{payload}</script>'


def _inject(page: str, config: dict, base: bool = True) -> str:
    # The page links its files relative to the root, also under /<handle>/<slug>. The account page links every file
    # by its full path, and its policy allows no <base>, so it gets the data block alone (base=False).
    inject = ("" if not base or re.search(r"<base\b", page, re.I) else '<base href="/">') + _script(config)
    head = re.search(r"<head\b[^>]*>", page, re.I)
    return page[: head.end()] + inject + page[head.end():] if head else inject + page


def map_page(request: Request, config: dict, extra_headers: dict | None = None) -> HTMLResponse:
    page = request.app.state.page.text()
    if page is None:
        page = FALLBACK_PAGE.format(title=html.escape(config["map"]["title"]), api=html.escape(config["api"]))
    return HTMLResponse(_inject(page, config), headers={"Cache-Control": "no-store", **(extra_headers or {})})


def start_page(request: Request):
    """The start page of the site, with the account of the browser. Without START_FILE: the account page."""
    page = request.app.state.start.text()
    if page is None:
        return RedirectResponse("/account", status_code=302)
    user = current_user(request)
    config = {"mode": "site", "account": f"{settings_of(request).base_url}/account",
              "user": {"handle": user["handle"]} if user else None, "language": language_of(user)}
    # no-store: the page names the signed-in user. No other site may frame it, because it has buttons that write.
    return HTMLResponse(_inject(page, config), headers={
        "Cache-Control": "no-store", "Content-Security-Policy": site_policy("'self'"), "X-Frame-Options": "SAMEORIGIN"})


def language_of(user: dict | None) -> str | None:
    """The language of the signed-in account for the data block of a page, or None without a session."""
    return user["language"] if user else None


def _config(request: Request, row: dict, mode: str, api: str, writable: bool, user: dict | None = None) -> dict:
    return {
        "mode": mode,
        "api": api,
        "canWrite": writable,
        "map": {"title": row["title"], "slug": row["slug"], "owner": row["handle"], "visibility": row["visibility"]},
        "account": f"{settings_of(request).base_url}/account",
        "language": language_of(user),
    }


def _owner_or_public_page(request: Request, handle: str, slug: str) -> HTMLResponse:
    user = current_user(request)
    with pool_of(request).connection() as conn:
        row = map_at(conn, handle, slug, user)
    if row["role"] is not None:
        # No other site may frame the page of a member, so that nobody tricks him into clicks.
        config = {**_config(request, row, "owner", f"/api/maps/{row['id']}", can_write(row), user), "role": row["role"],
                  "canShare": allowed("map.share", row["role"])}
        return map_page(request, config,
                        {"Content-Security-Policy": site_policy("'self'"), "X-Frame-Options": "SAMEORIGIN"})
    return map_page(request, _config(request, row, "public", f"/api/public/{handle}/{slug}", False, user))


def _list_page(request: Request, handle: str, on_subdomain: bool) -> HTMLResponse:
    """The public maps of an owner. The name of the owner is the title and the heading, so that no text of the page
    needs a value: data-i18n carries none. An owner without a public map gets the answer of an unknown handle, so that
    nobody learns from the address who has an account (finding A7 of the final review). Only the owner and the members
    of a team get the empty list there, because the account page links the address."""
    user = current_user(request)
    with pool_of(request).connection() as conn:
        owner, maps = public_maps(conn, handle)
        if not maps and not sees_owner(conn, owner, user):
            raise not_found()
    name = html.escape(owner["name"] or owner["handle"])
    prefix = "/" if on_subdomain else f"/{owner['handle']}/"
    items = "".join(
        f'<li><a href="{html.escape(prefix + row["slug"])}">{html.escape(row["title"])}</a></li>' for row in maps
    )
    body = (f'<p data-i18n="server.list.lead">Public maps</p><ul>{items}</ul>' if items
            else '<p data-i18n="server.list.empty">There are no public maps here yet.</p>')
    return HTMLResponse(
        f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{name}</title>
{TEXTS_SCRIPT}
<style>body{{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5}}
@media (prefers-color-scheme: dark){{body{{background:#14171a;color:#e6e6e6}}a{{color:#8ab4f8}}}}</style></head>
<body><main><h1>{name}</h1>{body}</main></body></html>""",
        # no-store: the empty list shows only to the owner and to the members of a team.
        headers={"Cache-Control": "no-store"},
    )


def _owner_page(request: Request, handle: str, on_subdomain: bool) -> HTMLResponse:
    """The address of an owner, <BASE_URL>/<handle> or "/" of its subdomain: the start map of the owner while it is
    public, with the map page that /<handle>/<slug> gives the visitor. Else the list of the public maps of the owner."""
    with pool_of(request).connection() as conn:
        slug = public_start_map(conn, handle)
    if slug is None:
        return _list_page(request, handle, on_subdomain)
    return _owner_or_public_page(request, handle, slug)


@router.get("/account", include_in_schema=False)
def account(request: Request):
    """The account page, with the data block {mode: "account", user, language}. no-store, because the block names the
    signed-in user."""
    if site_handle(request):
        return RedirectResponse(f"{settings_of(request).base_url}/account", status_code=302)
    user = current_user(request)
    config = {"mode": "account", "user": {"handle": user["handle"]} if user else None, "language": language_of(user)}
    return HTMLResponse(_inject(ACCOUNT_PAGE.text(), config, base=False), headers={**ACCOUNT_POLICY, "Cache-Control": "no-store"})


@router.get("/account/{name}", include_in_schema=False)
def account_file(name: str):
    if name not in ACCOUNT_FILES:
        raise not_found()
    return FileResponse(STATIC / name, media_type=ACCOUNT_FILES[name], headers=ACCOUNT_HEADERS)


@router.get("/s/{token}", include_in_schema=False)
def shared_page(token: str, request: Request):
    with pool_of(request).connection() as conn:
        row = shared_map(conn, token)
    only_on_own_site(request, row["handle"])
    # no-referrer: the token in the address must not leak to other sites through links on the page.
    return map_page(request, _config(request, row, "shared", f"/api/shared/{token}", False, current_user(request)),
                    {"Referrer-Policy": "no-referrer"})


def _embed_page(request: Request, find, api: str, full: str) -> HTMLResponse:
    """The embed view of the map that find(conn) gives, or the frameable 404 page."""
    if site_handle(request):
        raise not_found()
    try:
        with pool_of(request).connection() as conn:
            row = find(conn)
    except ApiError as error:
        if error.status != 404:
            raise
        return HTMLResponse(EMBED_MISSING, 404, headers={
            "Content-Security-Policy": site_policy("*"), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})
    config = {**_config(request, row, "embed", api, False), "embed": {"open": full}}
    # no-referrer: a link of the frame never names the page around it, and a share link never leaks.
    return map_page(request, config, {"Content-Security-Policy": site_policy(frame_ancestors(row)),
                                      "Referrer-Policy": "no-referrer"})


# The share link first: "s" is never a handle, because a handle has at least 3 characters.
@router.get("/e/s/{token}", include_in_schema=False)
def embed_shared(token: str, request: Request):
    base = settings_of(request).base_url
    return _embed_page(request, lambda conn: shared_map(conn, token), f"/api/shared/{token}", f"{base}/s/{token}")


@router.get("/e/{handle}/{slug}", include_in_schema=False)
def embed_public(handle: str, slug: str, request: Request):
    # Without a user: the embed view of a map that is not public is a 404, also for its owner and for a team member.
    return _embed_page(request, lambda conn: map_at(conn, handle, slug), f"/api/public/{handle}/{slug}",
                       settings_of(request).map_url(handle, slug))


@router.get("/", include_in_schema=False)
def root(request: Request):
    handle = site_handle(request)
    if handle is None:
        return start_page(request)
    return _owner_page(request, handle, True)


@router.get("/index.html", include_in_schema=False)
def index(request: Request):
    # The map pages of stage a link to index.html; on the server it is the start page with the account too.
    if site_handle(request):
        raise not_found()
    return start_page(request)


# The two routes of the addresses come last, because they take every path of one or two names that no route before
# them takes.
@router.get("/{name}", include_in_schema=False)
def owner_page(name: str, request: Request):
    """On the main domain: the address of an owner, <BASE_URL>/<handle>. On a subdomain: the map /<slug> of its owner.
    There, /<the handle of the subdomain> is the address of the owner at the main domain, typed on the subdomain. A map
    with that slug still wins. Else the answer is a 308 to "/" of the subdomain, which is the address of the owner
    there. A map that the visitor may not read gets the same 308, so that nobody learns that it exists."""
    handle = site_handle(request)
    if handle is not None:
        try:
            return _owner_or_public_page(request, handle, name)
        except ApiError as error:
            if error.status != 404 or name != handle:
                raise
        query = request.scope.get("query_string") or b""
        location = settings_of(request).site_url(handle) + "/" + ("?" + query.decode("latin-1") if query else "")
        return RedirectResponse(location, 308)
    if handle_problem(name):
        raise not_found()
    return _owner_page(request, name, False)


@router.get("/{handle:handle}/{slug}", include_in_schema=False)
def owner_map_page(handle: str, slug: str, request: Request):
    """A map, <BASE_URL>/<handle>/<slug>. On the subdomain of its owner too, but not on another subdomain."""
    if handle_problem(handle):
        raise not_found()
    only_on_own_site(request, handle)
    return _owner_or_public_page(request, handle, slug)
