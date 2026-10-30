"""Accounts: register with double opt-in, login, logout, password reset and change, the language, delete, export.

Each account has a language (users.language, migration 0004_language): the language of its mails and of its pages.
A registration names it, and PATCH /api/account changes it. Without one, an account gets English."""
from __future__ import annotations

import io
import json
import zipfile
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Request, Response
from fastapi.responses import JSONResponse
from psycopg import errors as pg_errors
from pydantic import BaseModel, Field

from . import handles, mail, ratelimit, texts
from .errors import ApiError, bad
from .security import (
    DUMMY_HASH, handle_problem, hash_password, hash_token, needs_rehash, new_token, normalize_email,
    PASSWORD_MAX, PASSWORD_MIN, password_problem, password_verdict, verify_password,
)
from .sessions import (
    LIVE_SESSION, clear_session_cookie, create_session, current_user, ip_key_of, pool_of, require_user, session_token,
    set_session_cookie, settings_of,
)
from .store import export_map, map_filename
from .util import iso, now_iso

router = APIRouter(prefix="/api")

CONFIRM_HOURS = 48
RESET_MINUTES = 60
UNCONFIRMED_DAYS = 7

# The answers of a success. Their message is English, like the message of an error; a page shows its own text for the
# status.
CHECK_MAIL = {"status": "check_mail", "message": "If the details are right, we sent you an e-mail. Please follow the link "
                                                 "in it."}


def invalid_login() -> ApiError:
    return ApiError(401, "invalid_credentials")


def check_language(code) -> str:
    """A language of the server (the folders of server/app/i18n), or the error bad_language."""
    if not texts.known(code):
        raise bad("bad_language", languages=", ".join(texts.LANGUAGES))
    return code


class RegisterBody(BaseModel):
    email: str = Field(max_length=320)
    password: str = Field(max_length=4096)
    handle: str = Field(max_length=64)
    language: str | None = Field(default=None, max_length=20)


class AccountChange(BaseModel):
    language: str | None = Field(default=None, max_length=20)


class LoginBody(BaseModel):
    email: str = Field(max_length=320)
    password: str = Field(max_length=4096)


class ConfirmBody(BaseModel):
    token: str = Field(max_length=128)
    password: str = Field(max_length=4096)


class EmailBody(BaseModel):
    email: str = Field(max_length=320)


class ResetBody(BaseModel):
    token: str = Field(max_length=128)
    password: str = Field(max_length=4096)


class PasswordChangeBody(BaseModel):
    current: str = Field(max_length=4096)
    new: str = Field(max_length=4096)


class PasswordBody(BaseModel):
    password: str = Field(max_length=4096)


class PasswordCheckBody(BaseModel):
    password: str = Field(max_length=4096)
    email: str = Field(default="", max_length=320)
    handle: str = Field(default="", max_length=64)


def _issue_token(conn, user_id, purpose: str, minutes: int) -> str:
    conn.execute("DELETE FROM email_tokens WHERE user_id = %s AND purpose = %s", (user_id, purpose))
    token = new_token()
    conn.execute(
        "INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at)"
        " VALUES (%s, %s, %s, now() + make_interval(mins => %s))",
        (hash_token(token), user_id, purpose, minutes),
    )
    return token


def _take_token(conn, token: str, purpose: str):
    """Marks a valid token as used and returns its user id, or None."""
    row = conn.execute(
        "UPDATE email_tokens SET used_at = now()"
        " WHERE token_hash = %s AND purpose = %s AND used_at IS NULL AND expires_at > now()"
        " RETURNING user_id",
        (hash_token(token), purpose),
    ).fetchone()
    return row["user_id"] if row else None


def _queue_mail(background: BackgroundTasks, request: Request, to: str, subject_and_text: tuple[str, str]) -> None:
    background.add_task(mail.send_quietly, settings_of(request), to, *subject_and_text)


def forget_unconfirmed(conn) -> None:
    """Deletes each account that nobody confirmed for UNCONFIRMED_DAYS. It never had a public page, so its handle is free
    at once and gets no hold (handles.py). Every path that takes a handle runs it before it checks the handle: a
    registration, a new team and the new handle of a team."""
    conn.execute(
        "DELETE FROM owners o USING users u WHERE u.id = o.id AND u.confirmed_at IS NULL"
        " AND u.created_at < now() - make_interval(days => %s)",
        (UNCONFIRMED_DAYS,),
    )


@router.post("/auth/register", status_code=202)
def register(body: RegisterBody, request: Request, background: BackgroundTasks):
    settings, pool = settings_of(request), pool_of(request)
    ratelimit.enforce(pool, settings.limits, "register_ip", ip_key_of(request))
    email = normalize_email(body.email)
    if email is None:
        raise bad("invalid_email")
    handle = body.handle.strip().lower()
    problem = handle_problem(handle)
    if problem:
        raise problem
    weak = password_problem(body.password, email, handle)
    if weak:
        raise weak
    language = check_language(body.language) if body.language is not None else texts.SOURCE
    password_hash = hash_password(body.password)
    handles.forget_expired(pool, settings.handle_hold_days)
    try:
        with pool.connection() as conn:
            forget_unconfirmed(conn)
            existing = conn.execute(
                "SELECT u.id, u.confirmed_at, u.language, o.handle FROM users u JOIN owners o ON o.id = u.id"
                " WHERE lower(u.email) = %s",
                (email,),
            ).fetchone()
            # A registration that nobody confirmed may keep its own handle. Every other owner, and every hold of a freed
            # handle, makes the handle taken.
            unconfirmed = existing["id"] if existing and existing["confirmed_at"] is None else None
            handles.check_free(conn, handle, settings.handle_hold_days, unconfirmed)
            # Each registration from here on sends a mail to the address: the confirmation, or the notice to the owner of
            # a known address. Both count against the address in the same way, so the answer at the limit does not tell
            # whether the address has an account. A registration that fails before, for example with a taken handle,
            # sends no mail and does not count.
            ratelimit.enforce_in(conn, settings.limits, "register_account", email)
            if existing and existing["confirmed_at"] is not None:
                # The mail goes to the owner of the account, so it takes the language of the account.
                _queue_mail(background, request, email, mail.already_registered_mail(settings, existing["language"]))
                return CHECK_MAIL
            if existing:
                # A registration that was never confirmed: the new one replaces it, with its language.
                user_id = existing["id"]
                conn.execute("UPDATE owners SET handle = %s WHERE id = %s", (handle, user_id))
                conn.execute(
                    "UPDATE users SET password_hash = %s, language = %s, created_at = now(), password_changed_at = now()"
                    " WHERE id = %s",
                    (password_hash, language, user_id),
                )
            else:
                user_id = conn.execute(
                    "INSERT INTO owners (kind, handle) VALUES ('user', %s) RETURNING id", (handle,)
                ).fetchone()["id"]
                conn.execute(
                    "INSERT INTO users (id, email, password_hash, language) VALUES (%s, %s, %s, %s)",
                    (user_id, email, password_hash, language),
                )
            handles.take(conn, handle)
            token = _issue_token(conn, user_id, "confirm", CONFIRM_HOURS * 60)
    except pg_errors.UniqueViolation:
        # Two registrations at the same moment; the other one won.
        raise handles.handle_taken() from None
    _queue_mail(background, request, email, mail.confirm_mail(settings, language, handle, token, CONFIRM_HOURS))
    return CHECK_MAIL


@router.post("/auth/confirm")
def confirm(body: ConfirmBody, request: Request):
    """Confirms a registration. It needs the token of the mail and the password of the registration, so only somebody
    who holds both the mailbox and the password confirms an account. A second registration of an unconfirmed address
    replaces the first one with its own password: whoever sent it has no mail, and the owner of the mailbox does not
    know its password. The owner of the address registers again instead."""
    settings, pool = settings_of(request), pool_of(request)
    ratelimit.enforce(pool, settings.limits, "login_ip", ip_key_of(request))
    with pool.connection() as conn:
        user_id = _take_token(conn, body.token, "confirm")
        if user_id is None:
            raise bad("invalid_token", "register")
        row = conn.execute("SELECT password_hash FROM users WHERE id = %s", (user_id,)).fetchone()
        if not verify_password(row["password_hash"], body.password):
            # Rolls back, so the link still works.
            raise ApiError(401, "wrong_password", "confirm")
        conn.execute("UPDATE users SET confirmed_at = now() WHERE id = %s AND confirmed_at IS NULL", (user_id,))
    return {"status": "confirmed", "message": "Your account is confirmed. You can sign in now."}


@router.post("/auth/login")
def login(body: LoginBody, request: Request):
    settings, pool = settings_of(request), pool_of(request)
    email = normalize_email(body.email) or body.email.strip().lower()
    ratelimit.enforce(pool, settings.limits, "login_ip", ip_key_of(request))
    ratelimit.enforce(pool, settings.limits, "login_account", email)
    with pool.connection() as conn:
        user = conn.execute(
            "SELECT u.id, u.email, u.password_hash, u.confirmed_at, u.language, o.handle FROM users u"
            " JOIN owners o ON o.id = u.id WHERE lower(u.email) = %s",
            (email,),
        ).fetchone()
        if not verify_password(user["password_hash"] if user else DUMMY_HASH, body.password) or not user:
            raise invalid_login()
        if user["confirmed_at"] is None:
            raise ApiError(403, "not_confirmed")
        if needs_rehash(user["password_hash"]):
            conn.execute("UPDATE users SET password_hash = %s WHERE id = %s",
                         (hash_password(body.password), user["id"]))
        old = session_token(request)
        if old:
            conn.execute("DELETE FROM sessions WHERE id_hash = %s", (hash_token(old),))
        # The sessions of the user that have ended go: past their fixed end, or unused for SESSION_IDLE_DAYS.
        conn.execute(
            "DELETE FROM sessions s WHERE s.user_id = %(user)s AND NOT (" + LIVE_SESSION + ")",
            {"user": user["id"], "days": settings.session_days, "idle": settings.session_idle_days},
        )
        token, expires_at = create_session(conn, settings, user["id"])
    response = JSONResponse({"handle": user["handle"], "email": user["email"], "language": user["language"]})
    set_session_cookie(response, settings, token, expires_at)
    return response


@router.post("/auth/logout", status_code=204)
def logout(request: Request):
    settings = settings_of(request)
    token = session_token(request)
    if token:
        with pool_of(request).connection() as conn:
            conn.execute("DELETE FROM sessions WHERE id_hash = %s", (hash_token(token),))
    response = Response(status_code=204)
    clear_session_cookie(response, settings)
    return response


@router.post("/auth/reset-request", status_code=202)
def reset_request(body: EmailBody, request: Request, background: BackgroundTasks):
    settings, pool = settings_of(request), pool_of(request)
    email = normalize_email(body.email) or body.email.strip().lower()
    ratelimit.enforce(pool, settings.limits, "reset_ip", ip_key_of(request))
    ratelimit.enforce(pool, settings.limits, "reset_account", email)
    with pool.connection() as conn:
        user = conn.execute(
            "SELECT u.id, u.email, u.confirmed_at, u.language, o.handle FROM users u JOIN owners o ON o.id = u.id"
            " WHERE lower(u.email) = %s",
            (email,),
        ).fetchone()
        # Each mail takes the language of the account.
        if user and user["confirmed_at"] is not None:
            token = _issue_token(conn, user["id"], "reset", RESET_MINUTES)
            _queue_mail(background, request, user["email"],
                        mail.reset_mail(settings, user["language"], user["handle"], token))
        elif user:
            # Not confirmed yet: send the confirmation link again instead.
            token = _issue_token(conn, user["id"], "confirm", CONFIRM_HOURS * 60)
            _queue_mail(background, request, user["email"],
                        mail.confirm_mail(settings, user["language"], user["handle"], token, CONFIRM_HOURS))
    return CHECK_MAIL


@router.post("/auth/reset")
def reset(body: ResetBody, request: Request):
    settings, pool = settings_of(request), pool_of(request)
    ratelimit.enforce(pool, settings.limits, "reset_ip", ip_key_of(request))
    with pool.connection() as conn:
        user_id = _take_token(conn, body.token, "reset")
        if user_id is None:
            raise bad("invalid_token", "reset")
        user = conn.execute(
            "SELECT u.email, o.handle FROM users u JOIN owners o ON o.id = u.id WHERE u.id = %s", (user_id,)
        ).fetchone()
        weak = password_problem(body.password, user["email"], user["handle"])
        if weak:
            raise weak  # rolls back, so the link still works
        conn.execute("UPDATE users SET password_hash = %s, password_changed_at = now() WHERE id = %s",
                     (hash_password(body.password), user_id))
        conn.execute("DELETE FROM sessions WHERE user_id = %s", (user_id,))
        conn.execute("DELETE FROM email_tokens WHERE user_id = %s AND purpose = 'reset'", (user_id,))
    return {"status": "password_changed", "message": "Your new password is set. Please sign in."}


@router.post("/auth/password-check")
def password_check(body: PasswordCheckBody, request: Request):
    """The rule of a new password applied to this one, for the strength meter of the account page. It stores nothing.
    The e-mail address and the handle of the body count as personal words; without them, those of the signed-in user."""
    settings, pool = settings_of(request), pool_of(request)
    ratelimit.enforce(pool, settings.limits, "password_check_ip", ip_key_of(request))
    email, handle = body.email.strip(), body.handle.strip()
    user = None if email or handle else current_user(request)
    if user:
        email, handle = user["email"], user["handle"]
    verdict = password_verdict(body.password, email, handle)
    return {"ok": verdict["problem"] is None, **verdict, "min": PASSWORD_MIN, "max": PASSWORD_MAX}


@router.get("/auth/session")
def session(request: Request):
    """Whether the browser is signed in. Always 200, so that pages can ask without an error in the console."""
    user = current_user(request)
    if user is None:
        return {"signedIn": False}
    return {"signedIn": True, "handle": user["handle"], "email": user["email"], "language": user["language"]}


@router.get("/account")
def account(request: Request):
    return _account(request, require_user(request))


@router.patch("/account")
def change_account(body: AccountChange, request: Request):
    """Changes the language of the account: the language of its mails and of its pages. Gives the account."""
    user = require_user(request)
    if body.language is not None:
        language = check_language(body.language)
        with pool_of(request).connection() as conn:
            conn.execute("UPDATE users SET language = %s WHERE id = %s", (language, user["id"]))
        user = {**user, "language": language}
        request.state.user = user
    return _account(request, user)


def _account(request: Request, user: dict) -> dict:
    with pool_of(request).connection() as conn:
        row = conn.execute(
            "SELECT o.created_at, (SELECT count(*) FROM maps m WHERE m.owner_id = o.id) AS maps,"
            " (SELECT count(*) FROM memberships ms WHERE ms.user_id = o.id) AS teams"
            " FROM owners o WHERE o.id = %s",
            (user["id"],),
        ).fetchone()
    settings = settings_of(request)
    return {
        "handle": user["handle"],
        "email": user["email"],
        "language": user["language"],
        "created": iso(row["created_at"]),
        "maps": row["maps"],
        "teams": row["teams"],
        "profileUrl": settings.owner_url(user["handle"]),
        "siteUrl": settings.site_url(user["handle"]),
    }


def check_password(conn, user: dict, password: str) -> None:
    row = conn.execute("SELECT password_hash FROM users WHERE id = %s", (user["id"],)).fetchone()
    if not verify_password(row["password_hash"], password):
        raise ApiError(401, "wrong_password", "current")


def _delete_sole_teams(conn, user: dict) -> None:
    """Before an account goes: a team in which the user is the only owner blocks the delete if it has other
    members (409 last_owner). A team in which the user is the only member goes with the account.

    It first locks every team in which the user is an owner, in the order of their ids, and only then counts the
    owners. Two owners of one team who delete their accounts at the same moment so run one after the other, and the
    second one counts without the first."""
    locked = [row["id"] for row in conn.execute(
        "SELECT t.id FROM memberships ms JOIN organizations t ON t.id = ms.organization_id"
        " WHERE ms.user_id = %s AND ms.role = 'owner' ORDER BY t.id FOR UPDATE OF t",
        (user["id"],),
    )]
    teams = conn.execute(
        "SELECT o.id, o.handle, (SELECT count(*) FROM memberships x WHERE x.organization_id = o.id) AS members"
        " FROM owners o WHERE o.id = ANY(%(teams)s) AND NOT EXISTS (SELECT 1 FROM memberships x"
        " WHERE x.organization_id = o.id AND x.role = 'owner' AND x.user_id <> %(user)s)"
        " ORDER BY o.handle",
        {"teams": locked, "user": user["id"]},
    ).fetchall()
    blocked = [team["handle"] for team in teams if team["members"] > 1]
    if blocked:
        raise ApiError(409, "last_owner", "account", teams=", ".join(blocked))
    for team in teams:
        # The public addresses of the team go with it, so its handle stays blocked (handles.py).
        handles.hold(conn, team["handle"], team["id"])
        conn.execute("DELETE FROM owners WHERE id = %s", (team["id"],))


@router.post("/account/password")
def change_password(body: PasswordChangeBody, request: Request):
    settings, pool = settings_of(request), pool_of(request)
    user = require_user(request)
    ratelimit.enforce(pool, settings.limits, "login_account", user["email"])
    with pool.connection() as conn:
        check_password(conn, user, body.current)
        weak = password_problem(body.new, user["email"], user["handle"])
        if weak:
            raise weak
        conn.execute("UPDATE users SET password_hash = %s, password_changed_at = now() WHERE id = %s",
                     (hash_password(body.new), user["id"]))
        # Every other device is signed out; this one gets a new session id.
        conn.execute("DELETE FROM sessions WHERE user_id = %s", (user["id"],))
        token, expires_at = create_session(conn, settings, user["id"])
    response = JSONResponse({"status": "password_changed", "message": "Your new password is set."})
    set_session_cookie(response, settings, token, expires_at)
    return response


@router.post("/account/delete", status_code=204)
def delete_account(body: PasswordBody, request: Request):
    settings, pool = settings_of(request), pool_of(request)
    user = require_user(request)
    ratelimit.enforce(pool, settings.limits, "login_account", user["email"])
    with pool.connection() as conn:
        # The row of the user first, as every write that counts what the user owns does (store.lock_owner). So a new
        # team or a new map of the user at the same moment ends before the delete counts the teams, or waits for it.
        conn.execute("SELECT 1 FROM owners WHERE id = %s FOR UPDATE", (user["id"],))
        check_password(conn, user, body.password)
        _delete_sole_teams(conn, user)
        # Only a confirmed account signs in, so this account had public addresses: its handle stays blocked.
        handles.hold(conn, user["handle"], user["id"])
        # The owner row cascades to the user, its sessions, tokens, memberships, maps, documents and share links.
        conn.execute("DELETE FROM owners WHERE id = %s", (user["id"],))
    response = Response(status_code=204)
    clear_session_cookie(response, settings)
    return response


@router.get("/account/export")
def export_account(request: Request):
    """All own maps as map files in one ZIP file, plus account.json."""
    user = require_user(request)
    buffer = io.BytesIO()
    with pool_of(request).connection() as conn:
        maps = conn.execute(
            "SELECT * FROM maps WHERE owner_id = %s ORDER BY created_at, slug", (user["id"],)
        ).fetchall()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("account.json", json.dumps({
                "handle": user["handle"], "email": user["email"], "language": user["language"], "exportedAt": now_iso(),
                "maps": [{"title": m["title"], "slug": m["slug"], "visibility": m["visibility"],
                          "embed": {"allow": m["embed_allow"], "origins": list(m["embed_origins"])},
                          "file": map_filename(m)} for m in maps],
            }, ensure_ascii=False, indent=2))
            for map_row in maps:
                archive.writestr(map_filename(map_row),
                                 json.dumps(export_map(conn, map_row), ensure_ascii=False, indent=2))
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return Response(
        buffer.getvalue(), media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="it-skills-{user["handle"]}-{stamp}.zip"',
                 "Cache-Control": "no-store"},
    )
