"""Read-only routes for readers: public maps by handle and slug, and maps behind a share link."""
from __future__ import annotations

from fastapi import APIRouter, Query, Request

from .access import map_at, public_maps, shared_map
from .errors import not_found
from .maps import documents_response
from .sessions import only_on_own_site, pool_of, settings_of
from .store import meta, snapshot

router = APIRouter(prefix="/api")


@router.get("/public/{handle}")
def list_public(handle: str, request: Request):
    only_on_own_site(request, handle)
    with pool_of(request).connection() as conn:
        owner, maps = public_maps(conn, handle)
    # An owner without a public map gets the answer of an unknown handle, so that nobody learns from it who has an
    # account (finding A7 of the final review).
    if not maps:
        raise not_found()
    settings = settings_of(request)
    return {
        "owner": owner["handle"],
        "profileUrl": settings.owner_url(owner["handle"]),
        "siteUrl": settings.site_url(owner["handle"]),
        "maps": [meta(row, row["handle"], settings, False) for row in maps],
    }


@router.get("/public/{handle}/{slug}")
def public_meta(handle: str, slug: str, request: Request):
    only_on_own_site(request, handle)
    with pool_of(request).connection() as conn:
        row = map_at(conn, handle, slug)
    return meta(row, row["handle"], settings_of(request), False)


@router.get("/public/{handle}/{slug}/docs")
def public_documents(handle: str, slug: str, request: Request, since: int | None = Query(default=None, ge=0)):
    only_on_own_site(request, handle)
    with pool_of(request).connection() as conn:
        snapshot(conn)
        row = map_at(conn, handle, slug)
        return documents_response(conn, row, since, False)


@router.get("/public/{handle}/{slug}/access")
def public_access(handle: str, slug: str, request: Request):
    only_on_own_site(request, handle)
    # Reads through this path never write, so canWrite is false even for the owner. The page of the owner
    # gets /api/maps/<id> as its source instead (see pages.py).
    with pool_of(request).connection() as conn:
        map_at(conn, handle, slug)
    return {"canWrite": False}


@router.get("/shared/{token}")
def shared_meta(token: str, request: Request):
    with pool_of(request).connection() as conn:
        row = shared_map(conn, token)
    only_on_own_site(request, row["handle"])
    return meta(row, row["handle"], settings_of(request), False)


@router.get("/shared/{token}/docs")
def shared_documents(token: str, request: Request, since: int | None = Query(default=None, ge=0)):
    with pool_of(request).connection() as conn:
        snapshot(conn)
        row = shared_map(conn, token)
        only_on_own_site(request, row["handle"])
        return documents_response(conn, row, since, False)


@router.get("/shared/{token}/access")
def shared_access(token: str, request: Request):
    with pool_of(request).connection() as conn:
        row = shared_map(conn, token)
    only_on_own_site(request, row["handle"])
    return {"canWrite": False}
