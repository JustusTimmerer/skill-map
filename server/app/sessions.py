"""Server-side sessions and the helpers that every route uses: settings, pool, client IP and the user."""
from __future__ import annotations

import math
from datetime import datetime, timezone

from fastapi import Request, Response
from psycopg_pool import ConnectionPool

from .config import Settings
from .errors import not_found, not_logged_in
from .security import client_ip, handle_problem, hash_token, new_token, rate_key


def settings_of(request: Request) -> Settings:
    return request.app.state.settings


def pool_of(request: Request) -> ConnectionPool:
    return request.app.state.pool


def ip_of(request: Request) -> str:
    peer = request.client.host if request.client else None
    return client_ip(peer, request.headers.get("x-forwarded-for"), settings_of(request).trusted_proxies)


def ip_key_of(request: Request) -> str:
    """The key of the client in every rate limit per IP: its IPv4 address, or the /64 network of its IPv6 address."""
    return rate_key(ip_of(request))


def host_label(request: Request) -> str | None:
    """The name before .<BASE_DOMAIN> in the host of a request, or None for the main host and for every other host. The
    main host (the host of BASE_URL) never has a label, also when it is a name below BASE_DOMAIN such as
    www.<BASE_DOMAIN>. A label that is no free handle names no user site: main.py answers it with 308 for www and 404
    for every other one."""
    settings = settings_of(request)
    domain = settings.base_domain
    if not domain:
        return None
    host = (request.headers.get("host") or "").lower().split(":")[0].rstrip(".")
    if host == settings.host or not host.endswith("." + domain):
        return None
    return host[: -len(domain) - 1]


def site_handle(request: Request) -> str | None:
    """The handle of a request to <handle>.<BASE_DOMAIN>, or None for the main domain."""
    label = host_label(request)
    return None if label is None or handle_problem(label) else label


def only_on_own_site(request: Request, handle: str) -> None:
    """The subdomain <handle>.<BASE_DOMAIN> is the site of one owner, so it serves only the maps of that owner. A path
    there that names a map or the list of another owner gets 404, so that nobody shows his map under the address of
    somebody else. The main domain serves the maps of every owner."""
    site = site_handle(request)
    if site is not None and site != (handle or "").strip().lower():
        raise not_found()


def cookie_name(settings: Settings) -> str:
    # The __Host- prefix makes the browser refuse the cookie unless it is Secure, has Path=/ and no Domain.
    return "session" if settings.local else "__Host-session"


def create_session(conn, settings: Settings, user_id) -> tuple[str, datetime]:
    """A new session: its token and its fixed end, SESSION_DAYS after the sign-in (expires_at). The end never moves."""
    token = new_token()
    row = conn.execute(
        "INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (%s, %s, now() + make_interval(days => %s))"
        " RETURNING expires_at",
        (hash_token(token), user_id, settings.session_days),
    ).fetchone()
    return token, row["expires_at"]


def set_session_cookie(response: Response, settings: Settings, token: str, expires_at: datetime) -> None:
    """The cookie of a new session. It ends at the fixed end of the session at the latest: its Max-Age is the whole
    seconds that are left until then."""
    left = (expires_at - datetime.now(timezone.utc)).total_seconds()
    response.set_cookie(
        cookie_name(settings), token, max_age=max(0, math.floor(left)), path="/",
        secure=not settings.local, httponly=True, samesite="lax",
    )


def clear_session_cookie(response: Response, settings: Settings) -> None:
    response.delete_cookie(cookie_name(settings), path="/", secure=not settings.local, httponly=True, samesite="lax")


def session_token(request: Request) -> str | None:
    token = request.cookies.get(cookie_name(settings_of(request)))
    return token if token and len(token) <= 128 else None


# A session lives while both of its ends lie ahead (selfhost/STUDY.md, "Security points for stage b"):
# - the fixed end, SESSION_DAYS after the sign-in. Use does not move it. created_at also counts, so that a lower
#   SESSION_DAYS ends older sessions too.
# - the idle end, SESSION_IDLE_DAYS after the last use. The server notes a use at most once an hour (last_seen_at), so
#   the idle end can come up to one hour before SESSION_IDLE_DAYS have passed since the last request.
LIVE_SESSION = (
    "s.expires_at > now() AND s.created_at > now() - make_interval(days => %(days)s)"
    " AND s.last_seen_at > now() - make_interval(days => %(idle)s)"
)


def current_user(request: Request) -> dict | None:
    """The signed-in user ({id, handle, email, language}) or None. A session ends SESSION_DAYS after the sign-in at the
    latest, and SESSION_IDLE_DAYS after its last use (LIVE_SESSION)."""
    if hasattr(request.state, "user"):
        return request.state.user
    user = None
    token = session_token(request)
    if token:
        settings = settings_of(request)
        with pool_of(request).connection() as conn:
            user = conn.execute(
                "SELECT u.id, o.handle, u.email, u.language, s.last_seen_at < now() - interval '1 hour' AS stale"
                " FROM sessions s JOIN users u ON u.id = s.user_id JOIN owners o ON o.id = u.id"
                f" WHERE s.id_hash = %(token)s AND {LIVE_SESSION} AND u.confirmed_at IS NOT NULL",
                {"token": hash_token(token), "days": settings.session_days, "idle": settings.session_idle_days},
            ).fetchone()
            if user and user.pop("stale"):
                # Only the idle end moves. The cookie keeps its end, which is the fixed end (set_session_cookie).
                conn.execute("UPDATE sessions SET last_seen_at = now() WHERE id_hash = %s", (hash_token(token),))
    request.state.user = user
    return user


def require_user(request: Request) -> dict:
    user = current_user(request)
    if user is None:
        raise not_logged_in()
    return user
