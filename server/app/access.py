"""Who may do what. Every access decision about a map or a team goes through allowed(), and every route
gets its map or team through map_for() or team_for(), which call it. No route checks a role itself.

An owner of a map is a user or a team. The role of a visitor for a map:
- the user who owns a personal map has the role "owner";
- a member of the team that owns a map has the role of the membership: "owner", "editor" or "reader";
- everyone else has no role (None). Such a visitor reads a public map and nothing else.

A visitor who may not read a map gets 404, so that nobody learns that it exists. A member who may read the
map but lacks the role for an action gets 403. A visitor without a role gets 404 for every action that is
no read, also on a public map, as in stage b."""
from __future__ import annotations

from .errors import ApiError, not_found
from .security import hash_token
from .util import parse_uuid

ROLES = ("owner", "editor", "reader")
MEMBERS = frozenset(ROLES)

# The roles that may do an action. This table is the whole permission system.
RULES: dict[str, frozenset] = {
    # Maps. A public map can also be read by visitors without a role (see allowed()).
    "map.read": MEMBERS,                            # the map, its documents, the access answer
    "map.export": MEMBERS,                          # the map file
    "map.write": frozenset({"owner", "editor"}),    # documents, title, slug
    "map.delete": frozenset({"owner", "editor"}),
    "map.share": frozenset({"owner"}),              # visibility and share links
    "map.move": frozenset({"owner"}),               # a personal map into a team
    # Teams.
    "team.view": MEMBERS,                           # the team, its members and its maps
    "team.leave": MEMBERS,
    "team.create_map": frozenset({"owner", "editor"}),  # new maps, imports and moves into the team
    "team.manage": frozenset({"owner"}),            # name, handle, members, roles, invitations, delete
}

# is_start: the map is the start map of its owner (migration 0007_start_map).
START_SQL = "COALESCE(o.start_map_id = m.id, false) AS is_start"
MAP_COLUMNS = f"m.*, o.handle, o.kind AS owner_kind, {START_SQL}"

# The role of the user %(user)s for the map m with the owner o, or NULL.
ROLE_SQL = (
    "CASE WHEN o.kind = 'user' THEN CASE WHEN m.owner_id = %(user)s THEN 'owner' END"
    " ELSE (SELECT ms.role FROM memberships ms WHERE ms.organization_id = m.owner_id AND ms.user_id = %(user)s)"
    " END AS role"
)


def allowed(action: str, role: str | None, visibility: str | None = None) -> bool:
    """The one decision: may a visitor with this role do this action? visibility counts only for reads."""
    if action == "map.read" and visibility == "public":
        return True
    return role in RULES[action]


def forbidden() -> ApiError:
    return ApiError(403, "forbidden")


def _user_id(user: dict | None):
    return user["id"] if user else None


def can_write(map_row: dict) -> bool:
    return allowed("map.write", map_row.get("role"))


def authorize(map_row: dict | None, action: str) -> dict:
    """The map if its visitor may do the action. 404 for a visitor who may not read it or has no role,
    403 for a member without the role."""
    if map_row is None or not allowed("map.read", map_row["role"], map_row["visibility"]):
        raise not_found()
    if not allowed(action, map_row["role"], map_row["visibility"]):
        raise forbidden() if map_row["role"] else not_found()
    return map_row


def find_map(conn, map_id: str, user: dict | None = None, lock: bool = False) -> dict | None:
    """The map with the handle and the kind of its owner and the role of the user in it."""
    map_id = parse_uuid(map_id)
    if map_id is None:
        return None
    return conn.execute(
        f"SELECT {MAP_COLUMNS}, {ROLE_SQL} FROM maps m JOIN owners o ON o.id = m.owner_id WHERE m.id = %(map)s"
        + (" FOR UPDATE OF m" if lock else ""),
        {"map": map_id, "user": _user_id(user)},
    ).fetchone()


def map_for(conn, map_id: str, user: dict | None, action: str, lock: bool = False) -> dict:
    return authorize(find_map(conn, map_id, user, lock), action)


def map_at(conn, handle: str, slug: str, user: dict | None = None) -> dict:
    """A map by the handle of its owner and its slug, if the visitor may read it. Without a user, only a
    public map."""
    map_row = conn.execute(
        f"SELECT {MAP_COLUMNS}, {ROLE_SQL} FROM maps m JOIN owners o ON o.id = m.owner_id"
        " WHERE o.handle = %(handle)s AND m.slug = %(slug)s",
        {"handle": handle, "slug": slug, "user": _user_id(user)},
    ).fetchone()
    return authorize(map_row, "map.read")


def shared_map(conn, token: str) -> dict:
    """The map of a share link. A link works while the map is shared by link or public. The link is the
    permission, so the role stays empty."""
    if not token or len(token) > 128:
        raise not_found()
    map_row = conn.execute(
        f"SELECT {MAP_COLUMNS}, NULL AS role FROM share_links l JOIN maps m ON m.id = l.map_id"
        " JOIN owners o ON o.id = m.owner_id WHERE l.token_hash = %s AND m.visibility IN ('link', 'public')",
        (hash_token(token),),
    ).fetchone()
    if map_row is None:
        raise not_found()
    return map_row


def public_maps(conn, handle: str) -> tuple[dict, list[dict]]:
    """A user or a team by handle, with its public maps. An unconfirmed user does not exist yet."""
    owner = conn.execute(
        "SELECT o.id, o.handle, o.kind, t.name FROM owners o LEFT JOIN users u ON u.id = o.id"
        " LEFT JOIN organizations t ON t.id = o.id"
        " WHERE o.handle = %s AND (o.kind <> 'user' OR u.confirmed_at IS NOT NULL)",
        (handle,),
    ).fetchone()
    if owner is None:
        raise not_found()
    maps = conn.execute(
        f"SELECT {MAP_COLUMNS}, NULL AS role FROM maps m JOIN owners o ON o.id = m.owner_id"
        " WHERE m.owner_id = %s AND m.visibility = 'public' ORDER BY m.updated_at DESC, m.slug",
        (owner["id"],),
    ).fetchall()
    return owner, maps


def sees_owner(conn, owner: dict, user: dict | None) -> bool:
    """True when the user is the owner (a user) or a member of the owner (a team, with the right team.view). Only they
    get the address of an owner without a public map: everyone else gets 404 there, as for an unknown handle (finding
    A7 of the final review)."""
    if user is None:
        return False
    if owner["kind"] == "user":
        return owner["id"] == user["id"]
    role = conn.execute("SELECT role FROM memberships WHERE organization_id = %s AND user_id = %s",
                        (owner["id"], user["id"])).fetchone()
    return allowed("team.view", role["role"] if role else None)


def public_start_map(conn, handle: str) -> str | None:
    """The slug of the start map of a user or a team, if the owner picked one and it is public, else None. Then the
    address of the owner shows the list of its public maps (pages.py)."""
    row = conn.execute(
        "SELECT m.slug FROM owners o JOIN maps m ON m.id = o.start_map_id AND m.owner_id = o.id"
        " LEFT JOIN users u ON u.id = o.id"
        " WHERE o.handle = %s AND m.visibility = 'public' AND (o.kind <> 'user' OR u.confirmed_at IS NOT NULL)",
        (handle,),
    ).fetchone()
    return row["slug"] if row else None


def find_team(conn, handle: str, user: dict | None, lock: bool = False) -> dict | None:
    """The team with the role of the user in it (or None as role)."""
    handle = (handle or "").strip().lower()
    return conn.execute(
        "SELECT o.id, o.handle, o.created_at, t.name, ms.role FROM owners o JOIN organizations t ON t.id = o.id"
        " LEFT JOIN memberships ms ON ms.organization_id = o.id AND ms.user_id = %s"
        " WHERE o.handle = %s" + (" FOR UPDATE OF t" if lock else ""),
        (_user_id(user), handle),
    ).fetchone()


def team_for(conn, handle: str, user: dict | None, action: str, lock: bool = False) -> dict:
    """The team if the user may do the action. 404 for a non-member, 403 for a member without the role.
    lock=True locks the team row, so that changes of its members run one after the other."""
    team = find_team(conn, handle, user, lock)
    if team is None or not allowed("team.view", team["role"]):
        raise not_found()
    if not allowed(action, team["role"]):
        raise forbidden()
    return team
