"""Routes of the maps under /api/maps: the maps, their documents, export, import, share links and the move
into a team. Every route gets its map through _map(), which calls access.map_for() with the action that it needs and
serves on a subdomain only the maps of its owner."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StrictBool

from . import store
from .access import START_SQL, allowed, authorize, can_write, forbidden, map_for, team_for
from .errors import ApiError, bad, not_found
from .security import hash_token, new_token
from .sessions import current_user, only_on_own_site, pool_of, require_user, settings_of
from .util import iso

router = APIRouter(prefix="/api/maps")


class NewMap(BaseModel):
    title: str = Field(max_length=400)
    slug: str | None = Field(default=None, max_length=100)
    visibility: str = "private"
    team: str | None = Field(default=None, max_length=64)


class EmbedChange(BaseModel):
    """Who may embed the map: allow "all" or "origins", and the list of origins. A missing field stays as it is."""
    allow: str | None = None
    origins: list[str] | None = Field(default=None, max_length=100)


class MapChange(BaseModel):
    title: str | None = Field(default=None, max_length=400)
    slug: str | None = Field(default=None, max_length=100)
    visibility: str | None = None
    embed: EmbedChange | None = None
    # true: the map becomes the start map of its owner, which <BASE_URL>/<handle> shows. false: it stops being it.
    start: StrictBool | None = None


class MoveBody(BaseModel):
    team: str = Field(max_length=64)


def _map(conn, request: Request, map_id: str, user: dict | None, action: str, lock: bool = False) -> dict:
    row = map_for(conn, map_id, user, action, lock)
    only_on_own_site(request, row["handle"])
    return row


def _map_after_owner(conn, request: Request, map_id: str, user: dict, action: str) -> dict:
    """The map, locked after the row of its owner, for a write that also writes or clears owners.start_map_id. Such a
    write keeps the lock order of store.lock_owner(): the row of the owner first, then the row of the map. The map is
    read again after the lock. If another request moved it to another owner meanwhile, the answer is 409 conflict."""
    first = _map(conn, request, map_id, user, action)
    if not store.lock_owner(conn, first["owner_id"]):
        raise not_found()
    row = _map(conn, request, map_id, user, action, lock=True)
    if row["owner_id"] != first["owner_id"]:
        raise ApiError(409, "conflict", "moved")
    return row


def _meta(request: Request, map_row: dict, owner_view: bool = True) -> dict:
    return store.meta(map_row, map_row["handle"], settings_of(request), owner_view)


def documents_response(conn, map_row: dict, since: int | None, can_write_map: bool) -> Response:
    """The answer of every .../docs route, for owners and readers alike. The route reads map_row in the snapshot of
    store.snapshot(), so that the version and the documents of the answer come from the same moment."""
    result = store.read_documents(conn, map_row, since)
    if result is None:
        return Response(status_code=304, headers={"Cache-Control": "no-store"})
    return JSONResponse(
        {"canWrite": can_write_map, **result},
        headers={"Cache-Control": "no-store"},
    )


def _target(conn, request: Request, user: dict, team: str | None) -> dict:
    """The owner of a new map: the user, or a team in which the user may create maps."""
    if team is None:
        return {"id": user["id"], "handle": user["handle"], "owner_kind": "user", "role": "owner"}
    row = team_for(conn, team, user, "team.create_map")
    return {"id": row["id"], "handle": row["handle"], "owner_kind": "organization", "role": row["role"]}


def _with_owner(row: dict, owner: dict) -> dict:
    return {**row, "handle": owner["handle"], "owner_kind": owner["owner_kind"], "role": owner["role"]}


@router.get("")
def list_maps(request: Request):
    """The personal maps of the user. The maps of a team are at /api/teams/{handle}/maps."""
    user = require_user(request)
    with pool_of(request).connection() as conn:
        rows = conn.execute(
            f"SELECT m.*, o.handle, o.kind AS owner_kind, {START_SQL}, 'owner' AS role,"
            " (SELECT count(*) FROM share_links l WHERE l.map_id = m.id) AS shares"
            " FROM maps m JOIN owners o ON o.id = m.owner_id WHERE m.owner_id = %s ORDER BY m.updated_at DESC",
            (user["id"],),
        ).fetchall()
    return {"maps": [{**_meta(request, row), "shares": row["shares"]} for row in rows]}


@router.post("", status_code=201)
def create(body: NewMap, request: Request):
    user = require_user(request)
    title = store.check_title(body.title)
    slug = store.check_slug(body.slug) if body.slug is not None else None
    visibility = store.check_visibility(body.visibility)
    with pool_of(request).connection() as conn:
        owner = _target(conn, request, user, body.team)
        if visibility != "private" and not allowed("map.share", owner["role"]):
            raise forbidden()
        row = store.create_map(conn, owner["id"], user["id"], title, slug, visibility, settings_of(request).max_maps)
    return _meta(request, _with_owner(row, owner))


@router.post("/import", status_code=201)
def import_map(request: Request, file: Any = Body(...), team: str | None = Query(default=None, max_length=64)):
    """A map file becomes a new private map of the user, or of a team with ?team=<handle>."""
    user = require_user(request)
    title, collections, total = store.parse_map_file(file, user["language"])
    with pool_of(request).connection() as conn:
        owner = _target(conn, request, user, team)
        row = store.create_map(conn, owner["id"], user["id"], title, None, "private", settings_of(request).max_maps)
        store.import_documents(conn, row, collections)
        row = conn.execute("UPDATE maps SET size_bytes = %s WHERE id = %s RETURNING *", (total, row["id"])).fetchone()
    return _meta(request, _with_owner(row, owner))


@router.get("/{map_id}")
def get_map(map_id: str, request: Request):
    user = current_user(request)
    with pool_of(request).connection() as conn:
        row = _map(conn, request, map_id, user, "map.read")
    return _meta(request, row, row["role"] is not None)


@router.patch("/{map_id}")
def change(map_id: str, body: MapChange, request: Request):
    """Renames a map, changes its slug, its visibility, who may embed it, or whether it is the start map of its owner.
    Raises the version like every write. A change of the visibility, of the embed setting or of the start map needs the
    right to share, because an embedded map shows on other sites and the start map shows at the address of the owner.
    A change that keeps all three as they are needs only the right to write.

    start true makes the map the start map of its owner and replaces the one before: an owner has one start map. The
    map can be the start map before it is public. <BASE_URL>/<handle> shows it only while it is public, and else the
    list of the public maps (pages.py)."""
    user = require_user(request)
    with pool_of(request).connection() as conn:
        if body.start is None:
            row = _map(conn, request, map_id, user, "map.write", lock=True)
        else:
            row = _map_after_owner(conn, request, map_id, user, "map.write")
        start = bool(row["is_start"]) if body.start is None else body.start
        title = store.check_title(body.title) if body.title is not None else row["title"]
        slug = store.check_slug(body.slug) if body.slug is not None else row["slug"]
        visibility = store.check_visibility(body.visibility) if body.visibility is not None else row["visibility"]
        embed_allow, embed_origins = row["embed_allow"], list(row["embed_origins"])
        if body.embed is not None:
            embed_allow, embed_origins = store.check_embed(body.embed.allow, body.embed.origins, embed_allow, embed_origins)
        embed_changed = (embed_allow, embed_origins) != (row["embed_allow"], list(row["embed_origins"]))
        start_changed = start != bool(row["is_start"])
        if visibility != row["visibility"] or embed_changed or start_changed:
            authorize(row, "map.share")
        if slug != row["slug"] and store.slug_used(conn, row["owner_id"], slug):
            raise store.slug_taken()
        updated = store.write_with_slug(conn, row["owner_id"], slug, slug, lambda chosen: conn.execute(
            "UPDATE maps SET title = %s, slug = %s, visibility = %s, embed_allow = %s, embed_origins = %s,"
            " version = version + 1, updated_at = now() WHERE id = %s RETURNING *",
            (title, chosen, visibility, embed_allow, embed_origins, row["id"]),
        ).fetchone())
        if start_changed and start:
            conn.execute("UPDATE owners SET start_map_id = %s WHERE id = %s", (row["id"], row["owner_id"]))
        elif start_changed:
            conn.execute("UPDATE owners SET start_map_id = NULL WHERE id = %s AND start_map_id = %s",
                         (row["owner_id"], row["id"]))
    return _meta(request, {**_with_owner(updated, row), "is_start": start})


@router.delete("/{map_id}", status_code=204)
def delete(map_id: str, request: Request):
    """Deletes a map. If it is the start map of its owner, the database clears owners.start_map_id (ON DELETE SET NULL),
    so the delete locks the row of the owner before the row of the map (_map_after_owner)."""
    user = require_user(request)
    with pool_of(request).connection() as conn:
        row = _map_after_owner(conn, request, map_id, user, "map.delete")
        conn.execute("DELETE FROM maps WHERE id = %s", (row["id"],))
    return Response(status_code=204)


@router.get("/{map_id}/access")
def access(map_id: str, request: Request):
    """canWrite for the page; role is owner, editor, reader, or null for a visitor of a public map."""
    user = current_user(request)
    with pool_of(request).connection() as conn:
        row = _map(conn, request, map_id, user, "map.read")
    return {"canWrite": can_write(row), "role": row["role"]}


@router.get("/{map_id}/docs")
def documents(map_id: str, request: Request, since: int | None = Query(default=None, ge=0)):
    user = current_user(request)
    with pool_of(request).connection() as conn:
        store.snapshot(conn)
        row = _map(conn, request, map_id, user, "map.read")
        return documents_response(conn, row, since, can_write(row))


@router.put("/{map_id}/docs/{collection}/{doc_id}")
def put_document(map_id: str, collection: str, doc_id: str, request: Request, data: Any = Body(...),
                 base: int | None = Query(default=None, ge=0)):
    """base (optional): the version that the writer knows the document from; a newer document gives 409 conflict."""
    user = require_user(request)
    store.check_collection(collection)
    store.check_doc_id(collection, doc_id)
    store.document_size(data)
    with pool_of(request).connection() as conn:
        row = _map(conn, request, map_id, user, "map.write", lock=True)
        store.check_base(conn, row, collection, doc_id, base)
        updated = store.put_document(conn, row, collection, doc_id, data)
    return {"version": updated["version"]}


@router.delete("/{map_id}/docs/{collection}/{doc_id}")
def delete_document(map_id: str, collection: str, doc_id: str, request: Request,
                    base: int | None = Query(default=None, ge=0)):
    user = require_user(request)
    store.check_collection(collection)
    store.check_doc_id(collection, doc_id)
    with pool_of(request).connection() as conn:
        row = _map(conn, request, map_id, user, "map.write", lock=True)
        store.check_base(conn, row, collection, doc_id, base, deleting=True)
        updated = store.delete_document(conn, row, collection, doc_id)
    return {"version": updated["version"]}


@router.get("/{map_id}/export")
def export(map_id: str, request: Request):
    user = require_user(request)
    with pool_of(request).connection() as conn:
        row = _map(conn, request, map_id, user, "map.export")
        file = store.export_map(conn, row)
    return JSONResponse(file, headers={
        "Content-Disposition": f'attachment; filename="{store.map_filename(row)}"', "Cache-Control": "no-store"})


@router.post("/{map_id}/move")
def move(map_id: str, body: MoveBody, request: Request):
    """Moves a personal map of the user into a team in which the user is owner or editor. The map keeps its
    documents and its version history. Its slug stays, or gets "-2" if the team has it.

    The map always arrives private, with embedding off (allow "origins" with no origin), and its share links are
    deleted, also when an owner of the team moves it. His decision of 2026-10-19, "Always arrive private": an editor
    cannot change the visibility of a team map, so a move that kept a public map public was a way around the right to
    share. An owner of the team shares the map again in the team.

    A start map stops being the start map of the user (migration 0007_start_map). The team does not get it as its start
    map.

    The lock order of store.lock_owner(): the rows of the owners first, the user and then the team, for the start map
    of the user and the count of the maps of the team, and only then the row of the map. An account delete also locks
    the user before a team that goes with it. After the lock, the map is read again, because another request can have
    moved or deleted it."""
    user = require_user(request)
    with pool_of(request).connection() as conn:
        row = _map(conn, request, map_id, user, "map.move")
        if row["owner_kind"] != "user":
            raise bad("not_own_map")
        team = team_for(conn, body.team, user, "team.create_map")
        if not store.lock_owner(conn, row["owner_id"]):
            raise not_found()
        store.check_room(conn, team["id"], settings_of(request).max_maps)
        row = _map(conn, request, map_id, user, "map.move", lock=True)
        if row["owner_kind"] != "user":
            raise bad("not_own_map")
        conn.execute("UPDATE owners SET start_map_id = NULL WHERE id = %s AND start_map_id = %s",
                     (row["owner_id"], row["id"]))
        updated = store.write_with_slug(conn, team["id"], None, row["slug"], lambda slug: conn.execute(
            "UPDATE maps SET owner_id = %s, slug = %s, visibility = 'private', embed_allow = 'origins',"
            " embed_origins = '{}', version = version + 1, updated_at = now() WHERE id = %s RETURNING *",
            (team["id"], slug, row["id"]),
        ).fetchone())
        conn.execute("DELETE FROM share_links WHERE map_id = %s", (row["id"],))
    return _meta(request, {**updated, "handle": team["handle"], "owner_kind": "organization", "role": team["role"]})


def _share(request: Request, row: dict) -> dict:
    """A read link as the owner sees it, with its token and its two addresses."""
    base = settings_of(request).base_url
    token = row["token"]
    return {"id": str(row["id"]), "mode": "read", "created": iso(row["created_at"]), "token": token,
            "url": f"{base}/s/{token}", "embedUrl": f"{base}/e/s/{token}"}


@router.get("/{map_id}/shares")
def list_shares(map_id: str, request: Request):
    """The read link of the map, every time with its token, so that the owner can copy it again. A map has at most
    one link (migration 0006); the list keeps room for other modes later."""
    user = require_user(request)
    with pool_of(request).connection() as conn:
        row = _map(conn, request, map_id, user, "map.share")
        links = conn.execute(
            "SELECT id, token, created_at FROM share_links WHERE map_id = %s ORDER BY created_at", (row["id"],)
        ).fetchall()
    return {"visibility": row["visibility"], "shares": [_share(request, link) for link in links]}


class ShareRequest(BaseModel):
    """replace true revokes the read link of the map and makes a new one ("Revoke and generate new link")."""
    replace: StrictBool = False


@router.post("/{map_id}/shares", status_code=201)
def create_share(map_id: str, request: Request, body: ShareRequest | None = None):
    """The read link of the map. His decision of 2026-10-19: one read link per map, and a new link is the way to revoke
    one. A map with a link keeps it and gets it back with 200, so that a client that posts to get the link does not
    revoke it. Only {"replace": true} revokes the link and makes a new one, in one transaction, so that the old token
    stops working at once. A map without a link gets a new one, with 201. The row lock on the map makes two requests at
    the same moment run one after the other, and the unique index on share_links.map_id holds the rule in the database
    too. A private map becomes "link", because the owner wants the link to work."""
    user = require_user(request)
    replace = body is not None and body.replace
    with pool_of(request).connection() as conn:
        row = _map(conn, request, map_id, user, "map.share", lock=True)
        if row["visibility"] == "private":
            conn.execute("UPDATE maps SET visibility = 'link', version = version + 1, updated_at = now() WHERE id = %s",
                         (row["id"],))
        link = None if replace else conn.execute(
            "SELECT id, token, created_at FROM share_links WHERE map_id = %s", (row["id"],)).fetchone()
        status = 200
        if link is None:
            token = new_token(24)
            conn.execute("DELETE FROM share_links WHERE map_id = %s", (row["id"],))
            link = conn.execute(
                "INSERT INTO share_links (map_id, token_hash, token, created_by) VALUES (%s, %s, %s, %s)"
                " RETURNING id, token, created_at",
                (row["id"], hash_token(token), token, user["id"]),
            ).fetchone()
            status = 201
    visibility = "link" if row["visibility"] == "private" else row["visibility"]
    return JSONResponse({**_share(request, link), "visibility": visibility}, status)
