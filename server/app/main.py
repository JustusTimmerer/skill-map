"""The app: FastAPI with the routes, the CSRF check, the body limits and the error format.

Start it as the Dockerfile does: `uvicorn --factory app.main:create_app --no-proxy-headers --no-server-header
--no-access-log`, with --host and --port."""
from __future__ import annotations

import logging
import re
import sys
import time
from contextlib import asynccontextmanager
from urllib.parse import quote

import psycopg
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.routing import Match

from . import accounts, maps, pages, readers, teams
from .config import Settings
from .db import make_pool
from .errors import ApiError
from .migrate import migrate
from .pages import PageFile, error_page, site_policy
from .security import handle_problem
from .sessions import host_label, site_handle
from .store import MAX_DOCUMENT, MAX_MAP

log = logging.getLogger("skill-map")

UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
CSRF_HEADER = "it-skills"
DOCUMENT_PATH = re.compile(r"^/api/maps/[^/]+/docs/[^/]+/[^/]+$")
SMALL_BODY = 64 * 1024


def body_limit(method: str, path: str) -> int:
    """The largest request body in bytes. Pretty-printed JSON may be up to twice the stored size."""
    if method == "PUT" and DOCUMENT_PATH.match(path):
        return 2 * MAX_DOCUMENT
    if method == "POST" and path == "/api/maps/import":
        return 2 * MAX_MAP
    return SMALL_BODY


def _too_large() -> HTTPException:
    # An HTTPException, because FastAPI turns any other error while it reads the body into a 400.
    return HTTPException(413, "body_too_large")


class BodyLimit:
    """Stops request bodies above body_limit, with or without a Content-Length header."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        limit = body_limit(scope["method"], scope["path"])
        length = dict(scope["headers"]).get(b"content-length")
        if length is not None and (not length.isdigit() or int(length) > limit):
            response = JSONResponse(ApiError(413, "body_too_large").body(), 413)
            return await response(scope, receive, send)
        received = 0

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise _too_large()
            return message

        await self.app(scope, limited_receive, send)


def _error(request: Request, error: ApiError, **extra):
    """The answer of an error: its JSON body for the API and for every write, else a small page (pages.error_page)."""
    if request.url.path.startswith("/api") or request.method != "GET":
        return JSONResponse({**error.body(), **extra}, error.status, headers=error.headers)
    return HTMLResponse(error_page(error), error.status, headers=error.headers)


def _no_user_site(request: Request, settings: Settings):
    """The answer for a host below BASE_DOMAIN that names no user site, or None for every other host (finding A5 of the
    final review). Such a host never served the main site well: each write there failed with 403 csrf, because its
    origin is not the main host. www.<BASE_DOMAIN> sends the browser to the same path and query on BASE_URL, with 308,
    so that a form or a write keeps its method. Every other name that is no free handle (RESERVED, or no handle at all)
    gets 404 for every path, the API too. The main host never gets here, also when it is www.<BASE_DOMAIN>
    (sessions.host_label)."""
    label = host_label(request)
    if label is None or not handle_problem(label):
        return None
    if label == "www":
        path = request.scope.get("raw_path") or quote(request.url.path).encode()
        query = request.scope.get("query_string") or b""
        location = settings.base_url + path.decode("latin-1") + ("?" + query.decode("latin-1") if query else "")
        return RedirectResponse(location, 308)
    return _error(request, ApiError(404, "not_found"))


def _without_slash(request: Request, settings: Settings):
    """The answer for a page address with a slash at the end, or None (finding B3 of the final review). The app turns
    off the slash redirect of Starlette: it built its address from the request, and uvicorn runs with
    --no-proxy-headers, so it sent the browser to http:// with the whole path, for example the token of a read link.
    Here a GET of a page, such as /<handle>/ or /s/<token>/, gets a 308 to the address without the slash, built from
    BASE_URL or from the address of the subdomain, if a route of the app takes that address. So the answer never names
    http:// or another host. The API gets no redirect: an address of the API with a slash at the end is a 404."""
    path = request.url.path
    if request.method not in ("GET", "HEAD") or not path.endswith("/") or path.startswith("/api/"):
        return None
    target = path.rstrip("/")
    scope = {**request.scope, "path": target}
    if not target or not any(route.matches(scope)[0] == Match.FULL for route in request.app.router.routes):
        return None
    handle = site_handle(request)
    query = request.scope.get("query_string") or b""
    base = settings.site_url(handle) if handle else settings.base_url
    return RedirectResponse(base + quote(target) + ("?" + query.decode("latin-1") if query else ""), 308)


def _open(settings: Settings, pool) -> None:
    """Migrates the database and opens the pool; waits up to 60 s for the database to come up."""
    deadline = time.monotonic() + 60
    while True:
        try:
            if settings.run_migrations:
                # migrate() logs each file that it applies, and the version of the database at the end.
                migrate(settings.database_url)
            break
        except psycopg.OperationalError:
            if time.monotonic() > deadline:
                raise
            time.sleep(1)
    pool.open(wait=True, timeout=30)


def _no_access_log(record: logging.LogRecord) -> bool:
    return False


class _Stderr(logging.StreamHandler):
    """Writes to the sys.stderr of the moment of each line, as the last resort handler of logging does. So a stream that
    a test puts in place of sys.stderr gets the lines too."""

    @property
    def stream(self):
        return sys.stderr

    @stream.setter
    def stream(self, value):
        pass


def log_to_stderr() -> None:
    """Sends the lines of the logger "skill-map" from INFO up to stderr, the log of the container. uvicorn sets up only its
    own loggers, and the root logger stays at WARNING without a handler, so every INFO line of the app got lost: the
    migrations that the app applies at its start, for example. The lines also still reach the handlers of the root
    logger, for example the one of pytest. The access log stays off (create_app)."""
    logger = logging.getLogger("skill-map")
    if not any(isinstance(handler, _Stderr) for handler in logger.handlers):
        handler = _Stderr()
        handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
        logger.addHandler(handler)
    logger.setLevel(logging.INFO)


def create_app(settings: Settings | None = None, pool=None) -> FastAPI:
    """With a pool from outside (the tests), the app neither migrates nor opens nor closes it."""
    log_to_stderr()
    # No access log, also when a start command lacks --no-access-log: such a log keeps IP addresses and the tokens of
    # share links (/s/<token>, /api/shared/<token>). A filter stays when a logging setup runs again later.
    access_log = logging.getLogger("uvicorn.access")
    if _no_access_log not in access_log.filters:
        access_log.addFilter(_no_access_log)
    settings = settings or Settings.from_env()
    own_pool = pool is None
    pool = pool if pool is not None else make_pool(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if own_pool:
            await run_in_threadpool(_open, settings, pool)
        yield
        if own_pool:
            await run_in_threadpool(pool.close)

    # redirect_slashes off: _without_slash answers an address with a slash at the end.
    app = FastAPI(title="it-skills server", version="1", lifespan=lifespan, redirect_slashes=False,
                  docs_url=None, redoc_url=None, openapi_url="/api/openapi.json")
    app.state.settings = settings
    app.state.pool = pool
    app.state.page = PageFile(settings.page_file)
    app.state.start = PageFile(settings.start_file)

    # BodyLimit runs inside csrf_and_headers, so that its 413 gets the headers of every answer too (finding B5 of the
    # final review). A middleware that the app adds later runs outside the ones before it.
    app.add_middleware(BodyLimit)

    @app.middleware("http")
    async def csrf_and_headers(request: Request, call_next):
        # Every answer gets the headers below: also the early answers of this middleware (the 308 and 404 of
        # _no_user_site and the 403 csrf) and the 413 of BodyLimit.
        response = _no_user_site(request, settings)
        if response is None and request.method in UNSAFE_METHODS:
            origin = (request.headers.get("origin") or "").lower().rstrip("/")
            if request.headers.get("x-requested-with") != CSRF_HEADER or origin != settings.origin:
                error = ApiError(403, "csrf")
                response = JSONResponse(error.body(), error.status)
        try:
            if response is None:
                response = await call_next(request)
        except Exception:  # noqa: BLE001 - every error that no handler took
            # The app answers the error itself. The last error handler of Starlette would send a plain 500 and raise the
            # error again, and uvicorn then closes the connection without "Connection: close". The proxy keeps its
            # connections to the app open, so its next request on that connection got a reset and answered 502.
            log.exception("unhandled error in %s %s", request.method, request.url.path)
            response = _error(request, ApiError(500, "internal"))
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        # The policy of the site (pages.py). No other site may frame a page of the app, so that nobody tricks a user into
        # clicks. Only an answer with its own policy differs: the embed view of a map (pages.py) and the account page,
        # which allows no frame at all.
        if "content-security-policy" not in response.headers:
            response.headers["Content-Security-Policy"] = site_policy("'self'")
            response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        if request.url.path.startswith("/api"):
            response.headers.setdefault("Cache-Control", "no-store")
        return response

    @app.exception_handler(ApiError)
    async def api_error(request: Request, error: ApiError):
        return _error(request, error)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, error: StarletteHTTPException):
        if error.status_code == 404:
            return _without_slash(request, settings) or _error(request, ApiError(404, "not_found"))
        if error.status_code == 405:
            return _error(request, ApiError(405, "method_not_allowed"))
        if error.status_code == 413:
            return _error(request, ApiError(413, "body_too_large"))
        # Any other status of Starlette keeps its status. It has no text of its own, so it says that the request failed.
        if error.status_code >= 500:
            return _error(request, ApiError(error.status_code, "internal"))
        return _error(request, ApiError(error.status_code, "invalid_request"))

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, error: RequestValidationError):
        fields = [".".join(str(part) for part in item.get("loc", ())) for item in error.errors()]
        return _error(request, ApiError(422, "invalid_request"), fields=fields)

    @app.exception_handler(RecursionError)
    async def too_deep(request: Request, error: RecursionError):
        return _error(request, ApiError(400, "invalid_document", "tooDeep"))

    @app.get("/api/health")
    def health():
        try:
            with pool.connection(timeout=5) as conn:
                conn.execute("SELECT 1")
        except Exception:  # noqa: BLE001 - any failure means: not healthy
            return JSONResponse({"status": "down"}, 503)
        return {"status": "ok"}

    app.include_router(accounts.router)
    app.include_router(maps.router)
    app.include_router(readers.router)
    app.include_router(teams.router)
    app.include_router(pages.router)  # last: it holds the catch-alls /{name} and /{handle}/{slug} of the addresses
    return app
