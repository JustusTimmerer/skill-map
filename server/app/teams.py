"""Teams (organizations): create, rename, delete, members and roles, invitations by e-mail, and the maps of
a team. Every route gets its team through access.team_for() with the action that it needs.

A team is an owner like a user, so it shares the handle namespace with the users. The roles are owner,
editor and reader (see access.RULES). A team always keeps at least one owner. Every change of the members
locks the row of the team first, so that two owners cannot remove each other at the same moment.

The lock order, as in store.lock_owner: the row of a user first, then the row of the team (team_for with lock=True),
then the rows of its invitations and members. A new owner (a new team, an accepted invitation with the role owner, a
new role owner) locks the row of that user before it counts the teams of the user (owns_too_many). The delete of a team
locks the row of the team before its delete reaches the invitations. So no two requests wait for each other in a
circle."""
from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Request, Response
from psycopg import errors as pg_errors
from pydantic import BaseModel, Field

from . import handles, mail, ratelimit
from .accounts import check_password, forget_unconfirmed
from .access import ROLES, START_SQL, allowed, forbidden, team_for
from .errors import ApiError, bad, not_found, not_logged_in
from .security import handle_problem, hash_token, new_token, normalize_email
from .sessions import current_user, pool_of, require_user, settings_of
from .store import lock_owner, meta
from .util import has_hidden, iso, parse_uuid

router = APIRouter(prefix="/api")

INVITE_DAYS = 7
# The answer of an invitation. Its message is English, like the message of an error.
INVITED = {"status": "invited", "message": "If the address is right, the invitation is sent."}


class NewTeam(BaseModel):
    name: str = Field(max_length=400)
    handle: str = Field(max_length=64)


class TeamChange(BaseModel):
    name: str | None = Field(default=None, max_length=400)
    handle: str | None = Field(default=None, max_length=64)


class PasswordBody(BaseModel):
    password: str = Field(max_length=4096)


class RoleBody(BaseModel):
    role: str = Field(max_length=20)


class InviteBody(BaseModel):
    email: str = Field(max_length=320)
    role: str = Field(max_length=20)


class TokenBody(BaseModel):
    token: str = Field(max_length=128)


def last_owner() -> ApiError:
    return ApiError(409, "last_owner", "member")


def check_name(name) -> str:
    """The name goes into the subject of every invitation mail, so it holds no line break and no hidden character."""
    name = name.strip() if isinstance(name, str) else ""
    if not 1 <= len(name) <= 100 or has_hidden(name):
        raise bad("invalid_name")
    return name


def check_handle(handle: str) -> str:
    handle = (handle or "").strip().lower()
    problem = handle_problem(handle)
    if problem:
        raise problem
    return handle


def check_role(role: str) -> str:
    if role not in ROLES:
        raise bad("invalid_role")
    return role


def team_view(request: Request, team: dict) -> dict:
    settings = settings_of(request)
    return {
        "handle": team["handle"],
        "name": team["name"],
        "role": team["role"],
        "created": iso(team["created_at"]),
        "profileUrl": settings.owner_url(team["handle"]),
        "siteUrl": settings.site_url(team["handle"]),
        "canManage": allowed("team.manage", team["role"]),
        "canEdit": allowed("team.create_map", team["role"]),
    }


def _members(conn, team_id) -> list[dict]:
    rows = conn.execute(
        "SELECT o.handle, ms.role, ms.created_at FROM memberships ms JOIN owners o ON o.id = ms.user_id"
        " WHERE ms.organization_id = %s"
        " ORDER BY array_position(ARRAY['owner', 'editor', 'reader'], ms.role), o.handle",
        (team_id,),
    ).fetchall()
    return [{"handle": r["handle"], "role": r["role"], "joined": iso(r["created_at"])} for r in rows]


def _owner_count(conn, team_id) -> int:
    return conn.execute(
        "SELECT count(*) AS n FROM memberships WHERE organization_id = %s AND role = 'owner'", (team_id,)
    ).fetchone()["n"]


def owns_too_many(conn, user_id, max_teams: int) -> bool:
    """True if the user is an owner of max_teams teams (MAX_TEAMS_PER_USER). Each team holds a public handle and its own
    quota of maps, so every path that makes a user an owner counts. The caller locks the row of the user first
    (store.lock_owner), so that parallel requests count one after the other."""
    owned = conn.execute(
        "SELECT count(*) AS n FROM memberships WHERE user_id = %s AND role = 'owner'", (user_id,)
    ).fetchone()["n"]
    return owned >= max_teams


def lock_team(conn, team_id) -> bool:
    """Locks the row of a team, as team_for(..., lock=True) does, and returns False if the team is gone."""
    return conn.execute("SELECT 1 FROM organizations WHERE id = %s FOR UPDATE", (team_id,)).fetchone() is not None


def _member(conn, team_id, handle: str) -> dict:
    row = conn.execute(
        "SELECT ms.user_id, ms.role, ms.created_at, o.handle FROM memberships ms JOIN owners o ON o.id = ms.user_id"
        " WHERE ms.organization_id = %s AND o.handle = %s",
        (team_id, (handle or "").strip().lower()),
    ).fetchone()
    if row is None:
        raise not_found()
    return row


@router.post("/teams", status_code=201)
def create_team(body: NewTeam, request: Request):
    user = require_user(request)
    name = check_name(body.name)
    handle = check_handle(body.handle)
    settings, pool = settings_of(request), pool_of(request)
    handles.forget_expired(pool, settings.handle_hold_days)
    try:
        with pool.connection() as conn:
            # The row of the user is locked before the count, so parallel requests stop exactly at MAX_TEAMS_PER_USER
            # (store.lock_owner). A user whose account went meanwhile has no session any more.
            if not lock_owner(conn, user["id"]):
                raise not_logged_in()
            if owns_too_many(conn, user["id"], settings.max_teams):
                raise ApiError(409, "too_many_teams", max=settings.max_teams, count=settings.max_teams)
            # As at a registration: an account that nobody confirmed for UNCONFIRMED_DAYS frees its handle.
            forget_unconfirmed(conn)
            handles.check_free(conn, handle, settings.handle_hold_days)
            team = conn.execute(
                "INSERT INTO owners (kind, handle) VALUES ('organization', %s) RETURNING id, handle, created_at",
                (handle,),
            ).fetchone()
            conn.execute("INSERT INTO organizations (id, name, created_by) VALUES (%s, %s, %s)",
                         (team["id"], name, user["id"]))
            conn.execute("INSERT INTO memberships (organization_id, user_id, role) VALUES (%s, %s, 'owner')",
                         (team["id"], user["id"]))
            handles.take(conn, handle)
    except pg_errors.UniqueViolation:
        raise handles.handle_taken() from None
    return {**team_view(request, {**team, "name": name, "role": "owner"}),
            "members": [{"handle": user["handle"], "role": "owner", "joined": iso(team["created_at"])}]}


@router.get("/teams")
def list_teams(request: Request):
    user = require_user(request)
    with pool_of(request).connection() as conn:
        rows = conn.execute(
            "SELECT o.id, o.handle, o.created_at, t.name, ms.role,"
            " (SELECT count(*) FROM memberships x WHERE x.organization_id = o.id) AS members,"
            " (SELECT count(*) FROM maps m WHERE m.owner_id = o.id) AS maps"
            " FROM memberships ms JOIN organizations t ON t.id = ms.organization_id JOIN owners o ON o.id = t.id"
            " WHERE ms.user_id = %s ORDER BY lower(t.name), o.handle",
            (user["id"],),
        ).fetchall()
    return {"teams": [{**team_view(request, row), "members": row["members"], "maps": row["maps"]} for row in rows]}


@router.get("/teams/{handle}")
def get_team(handle: str, request: Request):
    user = require_user(request)
    with pool_of(request).connection() as conn:
        team = team_for(conn, handle, user, "team.view")
        members = _members(conn, team["id"])
    return {**team_view(request, team), "members": members}


@router.patch("/teams/{handle}")
def change_team(handle: str, body: TeamChange, request: Request):
    """Renames a team. A new handle changes the addresses of its public maps; share links keep working. The old handle
    stays blocked for every other owner for HANDLE_HOLD_DAYS, and the team may take it back (handles.py)."""
    user = require_user(request)
    settings, pool = settings_of(request), pool_of(request)
    handles.forget_expired(pool, settings.handle_hold_days)
    try:
        with pool.connection() as conn:
            team = team_for(conn, handle, user, "team.manage", lock=True)
            name = check_name(body.name) if body.name is not None else team["name"]
            new_handle = check_handle(body.handle) if body.handle is not None else team["handle"]
            if new_handle != team["handle"]:
                # As at a registration and a new team: an account that nobody confirmed for UNCONFIRMED_DAYS frees its
                # handle.
                forget_unconfirmed(conn)
                handles.check_free(conn, new_handle, settings.handle_hold_days, team["id"])
                conn.execute("UPDATE owners SET handle = %s WHERE id = %s", (new_handle, team["id"]))
                handles.take(conn, new_handle)
                handles.hold(conn, team["handle"], team["id"])
            conn.execute("UPDATE organizations SET name = %s WHERE id = %s", (name, team["id"]))
            members = _members(conn, team["id"])
    except pg_errors.UniqueViolation:
        raise handles.handle_taken() from None
    return {**team_view(request, {**team, "name": name, "handle": new_handle}), "members": members}


@router.post("/teams/{handle}/delete", status_code=204)
def delete_team(handle: str, body: PasswordBody, request: Request):
    """Deletes the team with its members, invitations and maps. Needs the password of the owner. The handle stays
    blocked for HANDLE_HOLD_DAYS (handles.py)."""
    settings, pool = settings_of(request), pool_of(request)
    user = require_user(request)
    ratelimit.enforce(pool, settings.limits, "login_account", user["email"])
    with pool.connection() as conn:
        team = team_for(conn, handle, user, "team.manage", lock=True)
        check_password(conn, user, body.password)
        handles.hold(conn, team["handle"], team["id"])
        # The owner row cascades to the team, its memberships, invitations, maps, documents and share links.
        conn.execute("DELETE FROM owners WHERE id = %s", (team["id"],))
    return Response(status_code=204)


@router.get("/teams/{handle}/maps")
def team_maps(handle: str, request: Request):
    user = require_user(request)
    with pool_of(request).connection() as conn:
        team = team_for(conn, handle, user, "team.view")
        rows = conn.execute(
            f"SELECT m.*, o.handle, o.kind AS owner_kind, {START_SQL}, %s::text AS role,"
            " (SELECT count(*) FROM share_links l WHERE l.map_id = m.id) AS shares"
            " FROM maps m JOIN owners o ON o.id = m.owner_id WHERE m.owner_id = %s ORDER BY m.updated_at DESC",
            (team["role"], team["id"]),
        ).fetchall()
    settings = settings_of(request)
    return {"maps": [{**meta(row, row["handle"], settings, True), "shares": row["shares"]} for row in rows]}


@router.patch("/teams/{handle}/members/{member}")
def change_member(handle: str, member: str, body: RoleBody, request: Request):
    """Gives a member a new role. A member who becomes an owner counts against MAX_TEAMS_PER_USER: the row of that user
    is locked first, before the row of the team (the lock order of this module)."""
    user = require_user(request)
    role = check_role(body.role)
    settings = settings_of(request)
    with pool_of(request).connection() as conn:
        locked = None
        if role == "owner":
            first = _member(conn, team_for(conn, handle, user, "team.manage")["id"], member)
            if first["role"] != "owner" and lock_owner(conn, first["user_id"]):
                locked = first["user_id"]
        team = team_for(conn, handle, user, "team.manage", lock=True)
        target = _member(conn, team["id"], member)
        if role == "owner" and target["role"] != "owner":
            # The member of the first read changed meanwhile: the account went, or its role changed. The count needs
            # the lock of the member, so the request stops, as for a member who is gone.
            if target["user_id"] != locked:
                raise not_found()
            if owns_too_many(conn, target["user_id"], settings.max_teams):
                raise ApiError(409, "too_many_teams", "member", max=settings.max_teams, count=settings.max_teams)
        if target["role"] == "owner" and role != "owner" and _owner_count(conn, team["id"]) <= 1:
            raise last_owner()
        conn.execute("UPDATE memberships SET role = %s WHERE organization_id = %s AND user_id = %s",
                     (role, team["id"], target["user_id"]))
    return {"handle": target["handle"], "role": role, "joined": iso(target["created_at"])}


@router.delete("/teams/{handle}/members/{member}", status_code=204)
def remove_member(handle: str, member: str, request: Request):
    """An owner removes a member. Every member can remove himself: that is leaving the team."""
    user = require_user(request)
    with pool_of(request).connection() as conn:
        team = team_for(conn, handle, user, "team.view", lock=True)
        target = _member(conn, team["id"], member)
        if not allowed("team.leave" if target["user_id"] == user["id"] else "team.manage", team["role"]):
            raise forbidden()
        if target["role"] == "owner" and _owner_count(conn, team["id"]) <= 1:
            raise last_owner()
        conn.execute("DELETE FROM memberships WHERE organization_id = %s AND user_id = %s",
                     (team["id"], target["user_id"]))
    return Response(status_code=204)


def _invitation(row: dict) -> dict:
    return {"id": str(row["id"]), "email": row["email"], "role": row["role"], "created": iso(row["created_at"]),
            "expires": iso(row["expires_at"]), "invitedBy": row.get("inviter")}


@router.get("/teams/{handle}/invitations")
def list_invitations(handle: str, request: Request):
    user = require_user(request)
    with pool_of(request).connection() as conn:
        team = team_for(conn, handle, user, "team.manage")
        rows = conn.execute(
            "SELECT i.*, o.handle AS inviter FROM invitations i LEFT JOIN owners o ON o.id = i.invited_by"
            " WHERE i.organization_id = %s AND i.accepted_at IS NULL AND i.expires_at > now()"
            " ORDER BY i.created_at",
            (team["id"],),
        ).fetchall()
    return {"invitations": [_invitation(row) for row in rows]}


@router.post("/teams/{handle}/invitations", status_code=201)
def invite(handle: str, body: InviteBody, request: Request, background: BackgroundTasks):
    """Sends an invitation by e-mail. The answer is the same whether the address has an account or not. A new
    invitation to the same address replaces the open one."""
    settings, pool = settings_of(request), pool_of(request)
    user = require_user(request)
    email = normalize_email(body.email)
    if email is None:
        raise bad("invalid_email")
    role = check_role(body.role)
    with pool.connection() as conn:
        team = team_for(conn, handle, user, "team.manage")
    ratelimit.enforce(pool, settings.limits, "invite_user", str(user["id"]))
    ratelimit.enforce(pool, settings.limits, "invite_email", email)
    token = new_token()
    with pool.connection() as conn:
        # The row of the team first, before the rows of its invitations, as the delete of the team locks them. The role
        # is checked again under the lock.
        team = team_for(conn, handle, user, "team.manage", lock=True)
        conn.execute("DELETE FROM invitations WHERE organization_id = %s AND lower(email) = %s AND accepted_at IS NULL",
                     (team["id"], email))
        row = conn.execute(
            "INSERT INTO invitations (organization_id, email, role, token_hash, invited_by, expires_at)"
            " VALUES (%s, %s, %s, %s, %s, now() + make_interval(days => %s)) RETURNING *",
            (team["id"], email, role, hash_token(token), user["id"], INVITE_DAYS),
        ).fetchone()
        # The mail takes the language of the account with this address, or the language of the person who invites.
        found = conn.execute("SELECT language FROM users WHERE lower(email) = %s AND confirmed_at IS NOT NULL",
                             (email,)).fetchone()
    language = found["language"] if found else user["language"]
    background.add_task(mail.send_quietly, settings, email,
                        *mail.invite_mail(settings, language, user["handle"], team["name"], team["handle"], role,
                                          token, INVITE_DAYS))
    return {**INVITED, "invitation": _invitation({**row, "inviter": user["handle"]})}


@router.delete("/teams/{handle}/invitations/{invitation_id}", status_code=204)
def withdraw(handle: str, invitation_id: str, request: Request):
    user = require_user(request)
    invitation_id = parse_uuid(invitation_id)
    with pool_of(request).connection() as conn:
        team = team_for(conn, handle, user, "team.manage")
        if invitation_id is None or not conn.execute(
            "DELETE FROM invitations WHERE id = %s AND organization_id = %s AND accepted_at IS NULL RETURNING id",
            (invitation_id, team["id"]),
        ).fetchone():
            raise not_found()
    return Response(status_code=204)


def _open_invitation(conn, token: str, lock: bool = False) -> dict:
    row = conn.execute(
        "SELECT i.id, i.organization_id, i.role, i.expires_at, o.handle, t.name, p.handle AS inviter"
        " FROM invitations i JOIN organizations t ON t.id = i.organization_id JOIN owners o ON o.id = t.id"
        " LEFT JOIN owners p ON p.id = i.invited_by"
        " WHERE i.token_hash = %s AND i.accepted_at IS NULL AND i.expires_at > now()"
        + (" FOR UPDATE OF i" if lock else ""),
        (hash_token(token),),
    ).fetchone()
    if row is None:
        raise bad("invalid_token", "invitation")
    return row


@router.post("/invitations/lookup")
def lookup_invitation(body: TokenBody, request: Request):
    """Shows the team and the role of an invitation before it is accepted. Needs no session."""
    user = current_user(request)
    with pool_of(request).connection() as conn:
        row = _open_invitation(conn, body.token)
        current = None
        if user:
            found = conn.execute("SELECT role FROM memberships WHERE organization_id = %s AND user_id = %s",
                                 (row["organization_id"], user["id"])).fetchone()
            current = found["role"] if found else None
    return {"team": {"handle": row["handle"], "name": row["name"]}, "role": row["role"],
            "invitedBy": row["inviter"], "expires": iso(row["expires_at"]), "memberRole": current}


@router.post("/invitations/accept")
def accept_invitation(body: TokenBody, request: Request):
    """The signed-in user joins the team with the role of the invitation. Any account can accept. The role owner counts
    against MAX_TEAMS_PER_USER, as a new team does.

    The lock order of this module: the row of the user, then the row of the team, and only then the invitation. The
    delete of the team locks the row of the team before its delete reaches the invitation. So an accept and a delete at
    the same moment run one after the other: an accept after the delete finds no invitation (400 invalid_token)."""
    user = require_user(request)
    settings = settings_of(request)
    with pool_of(request).connection() as conn:
        first = _open_invitation(conn, body.token)
        if not lock_owner(conn, user["id"]):
            raise not_logged_in()
        lock_team(conn, first["organization_id"])
        row = _open_invitation(conn, body.token, lock=True)
        if conn.execute("SELECT 1 FROM memberships WHERE organization_id = %s AND user_id = %s",
                        (row["organization_id"], user["id"])).fetchone():
            raise ApiError(409, "already_member")
        if row["role"] == "owner" and owns_too_many(conn, user["id"], settings.max_teams):
            raise ApiError(409, "too_many_teams", max=settings.max_teams, count=settings.max_teams)
        # ON CONFLICT: a safety net. Two invitations of one user into one team wait for each other at the row of the team.
        if not conn.execute(
            "INSERT INTO memberships (organization_id, user_id, role) VALUES (%s, %s, %s)"
            " ON CONFLICT (organization_id, user_id) DO NOTHING RETURNING role",
            (row["organization_id"], user["id"], row["role"]),
        ).fetchone():
            raise ApiError(409, "already_member")
        conn.execute("UPDATE invitations SET accepted_at = now(), accepted_by = %s WHERE id = %s",
                     (user["id"], row["id"]))
        team = team_for(conn, row["handle"], user, "team.view")
        members = _members(conn, team["id"])
    return {**team_view(request, team), "members": members}
