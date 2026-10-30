"""Every map, document and team endpoint, called by five visitors: the owner, an editor and a reader of the
team, a signed-in user who is no member, and a signed-out visitor. Each case asserts one status code.

The map belongs to a team. It has the documents of the sample file and one share link. The cases run once
with a private map and once with a public map."""
from __future__ import annotations

from types import SimpleNamespace

import uuid

import pytest
from conftest import PASSWORD, unique
from fastapi.routing import APIRoute

from app.security import hash_token, new_token

VISITORS = ("owner", "editor", "reader", "stranger", "anonymous")

# name: (method, path, body, expected for a private map, expected for a public map). The order of the
# expected codes is the order of VISITORS. "{...}" in a path is filled from the world of the case.
MAP_CASES = {
    "list own maps": ("GET", "/api/maps", None, (200, 200, 200, 200, 401), (200, 200, 200, 200, 401)),
    "get map": ("GET", "/api/maps/{id}", None, (200, 200, 200, 404, 404), (200, 200, 200, 200, 200)),
    "rename map": ("PATCH", "/api/maps/{id}", {"title": "Neu"}, (200, 200, 403, 404, 401), (200, 200, 403, 404, 401)),
    "change slug": ("PATCH", "/api/maps/{id}", {"slug": "neu"}, (200, 200, 403, 404, 401), (200, 200, 403, 404, 401)),
    "change visibility": ("PATCH", "/api/maps/{id}", {"visibility": "link"},
                          (200, 403, 403, 404, 401), (200, 403, 403, 404, 401)),
    # Embedding shows the map on other sites, so a change of the embed setting needs the share right, like the
    # visibility. A new map lets every site embed it, so "all" keeps the setting and needs only the write right.
    "change embed setting": ("PATCH", "/api/maps/{id}", {"embed": {"allow": "origins"}},
                             (200, 403, 403, 404, 401), (200, 403, 403, 404, 401)),
    "keep embed setting": ("PATCH", "/api/maps/{id}", {"embed": {"allow": "all"}},
                           (200, 200, 403, 404, 401), (200, 200, 403, 404, 401)),
    "delete map": ("DELETE", "/api/maps/{id}", None, (204, 204, 403, 404, 401), (204, 204, 403, 404, 401)),
    "access": ("GET", "/api/maps/{id}/access", None, (200, 200, 200, 404, 404), (200, 200, 200, 200, 200)),
    "read documents": ("GET", "/api/maps/{id}/docs", None, (200, 200, 200, 404, 404), (200, 200, 200, 200, 200)),
    "poll documents": ("GET", "/api/maps/{id}/docs?since={version}", None,
                       (304, 304, 304, 404, 404), (304, 304, 304, 304, 304)),
    "write document": ("PUT", "/api/maps/{id}/docs/skills/neu", {"name": "Neu"},
                       (200, 200, 403, 404, 401), (200, 200, 403, 404, 401)),
    "delete document": ("DELETE", "/api/maps/{id}/docs/skills/python", None,
                        (200, 200, 403, 404, 401), (200, 200, 403, 404, 401)),
    "export": ("GET", "/api/maps/{id}/export", None, (200, 200, 200, 404, 401), (200, 200, 200, 404, 401)),
    "list shares": ("GET", "/api/maps/{id}/shares", None, (200, 403, 403, 404, 401), (200, 403, 403, 404, 401)),
    # A map has one read link. A new link revokes the old one, so no route revokes a link alone (his decision of
    # 2026-10-19): the old route is gone for everyone. The map of the world has a link, so a POST gives it with 200, and
    # only {"replace": true} makes a new one.
    "create share": ("POST", "/api/maps/{id}/shares", None, (200, 403, 403, 404, 401), (200, 403, 403, 404, 401)),
    "replace share": ("POST", "/api/maps/{id}/shares", {"replace": True}, (201, 403, 403, 404, 401), (201, 403, 403, 404, 401)),
    "revoke share": ("DELETE", "/api/maps/{id}/shares/{share}", None, (404,) * 5, (404,) * 5),
    # A map of a team is no own map, so nobody moves it; only an owner of a map may move at all.
    "move map": ("POST", "/api/maps/{id}/move", {"team": "{team}"}, (400, 403, 403, 404, 401), (400, 403, 403, 404, 401)),
    "map page": ("GET", "/{team}/{slug}", None, (200, 200, 200, 404, 404), (200, 200, 200, 200, 200)),
    "public meta": ("GET", "/api/public/{team}/{slug}", None, (404,) * 5, (200,) * 5),
    "public documents": ("GET", "/api/public/{team}/{slug}/docs", None, (404,) * 5, (200,) * 5),
    "public access": ("GET", "/api/public/{team}/{slug}/access", None, (404,) * 5, (200,) * 5),
    # A team without a public map is a 404 for everyone but its members, as an unknown handle (finding A7).
    "team list page": ("GET", "/{team}", None, (200, 200, 200, 404, 404), (200,) * 5),
    "shared meta": ("GET", "/api/shared/{token}", None, (404,) * 5, (200,) * 5),
    "shared documents": ("GET", "/api/shared/{token}/docs", None, (404,) * 5, (200,) * 5),
    "shared page": ("GET", "/s/{token}", None, (404,) * 5, (200,) * 5),
}

# name: (method, path, body, expected). Team endpoints do not depend on the visibility of a map.
TEAM_CASES = {
    "get team": ("GET", "/api/teams/{team}", None, (200, 200, 200, 404, 401)),
    "rename team": ("PATCH", "/api/teams/{team}", {"name": "Neuer Name"}, (200, 403, 403, 404, 401)),
    "delete team": ("POST", "/api/teams/{team}/delete", {"password": PASSWORD}, (204, 403, 403, 404, 401)),
    "team maps": ("GET", "/api/teams/{team}/maps", None, (200, 200, 200, 404, 401)),
    "create team map": ("POST", "/api/maps", {"title": "Neu", "team": "{team}"}, (201, 201, 403, 404, 401)),
    "import team map": ("POST", "/api/maps/import?team={team}", "sample", (201, 201, 403, 404, 401)),
    "change role": ("PATCH", "/api/teams/{team}/members/{reader}", {"role": "editor"}, (200, 403, 403, 404, 401)),
    # The editor removes himself here, which is leaving; nobody else but an owner removes a member.
    "remove member": ("DELETE", "/api/teams/{team}/members/{editor}", None, (204, 204, 403, 404, 401)),
    "list invitations": ("GET", "/api/teams/{team}/invitations", None, (200, 403, 403, 404, 401)),
    "invite": ("POST", "/api/teams/{team}/invitations", {"email": "neu@example.org", "role": "reader"},
               (201, 403, 403, 404, 401)),
    "withdraw invitation": ("DELETE", "/api/teams/{team}/invitations/{invitation}", None, (204, 403, 403, 404, 401)),
    # The token of an invitation is the permission: everyone sees it, and every signed-in non-member joins.
    "lookup invitation": ("POST", "/api/invitations/lookup", {"token": "{invite_token}"}, (200, 200, 200, 200, 200)),
    "accept invitation": ("POST", "/api/invitations/accept", {"token": "{invite_token}"}, (409, 409, 409, 200, 401)),
}

# The routes that need a role. Every one of them must have a case above.
GUARDED = ("/api/maps", "/api/teams", "/api/invitations")


@pytest.fixture
def world(quick_user, make_client, pool, sample_file):
    """A team with an owner, an editor and a reader, its map, a share link, an invitation and two outsiders."""
    def build(visibility: str):
        owner, editor, reader, stranger = (quick_user() for _ in range(4))
        handle = unique("t")
        assert owner.post("/api/teams", json={"name": "Team", "handle": handle}).status_code == 201
        with pool.connection() as conn:
            team_id = conn.execute("SELECT id FROM owners WHERE handle = %s", (handle,)).fetchone()["id"]
            for member, role in ((editor, "editor"), (reader, "reader")):
                conn.execute("INSERT INTO memberships (organization_id, user_id, role) VALUES (%s, %s, %s)",
                             (team_id, member.user_id, role))
        created = owner.post(f"/api/maps/import?team={handle}", json=sample_file).json()
        share = owner.post(f"/api/maps/{created['id']}/shares").json()
        changed = owner.patch(f"/api/maps/{created['id']}", json={"visibility": visibility}).json()
        invitation = owner.post(f"/api/teams/{handle}/invitations",
                                json={"email": "offen@example.org", "role": "editor"}).json()["invitation"]
        # A second invitation with a token that the test knows (the mail is not needed here).
        invite_token = new_token()
        with pool.connection() as conn:
            conn.execute("INSERT INTO invitations (organization_id, email, role, token_hash, expires_at)"
                         " VALUES (%s, 'bekannt@example.org', 'reader', %s, now() + interval '7 days')",
                         (team_id, hash_token(invite_token)))
        return SimpleNamespace(
            clients=dict(zip(VISITORS, (owner, editor, reader, stranger, make_client()))),
            values={"id": created["id"], "slug": created["slug"], "team": handle, "share": share["id"],
                    "token": share["token"], "version": changed["version"], "invitation": invitation["id"],
                    "invite_token": invite_token,
                    "editor": editor.handle, "reader": reader.handle},
            sample=sample_file,
        )
    return build


def fill(template, values: dict):
    if isinstance(template, str):
        return template.format(**values)
    if isinstance(template, dict):
        return {key: fill(value, values) for key, value in template.items()}
    return template


def call(world, visitor: str, method: str, path: str, body):
    client = world.clients[visitor]
    payload = world.sample if body == "sample" else fill(body, world.values)
    kwargs = {} if payload is None else {"json": payload}
    return client.request(method, fill(path, world.values), follow_redirects=False, **kwargs)


def case_id(name: str) -> str:
    return name.replace(" ", "-")


@pytest.mark.parametrize("visibility", ["private", "public"])
@pytest.mark.parametrize("visitor", VISITORS)
@pytest.mark.parametrize("case", list(MAP_CASES), ids=case_id)
def test_map_endpoint(world, case, visitor, visibility):
    method, path, body, private, public = MAP_CASES[case]
    expected = (private if visibility == "private" else public)[VISITORS.index(visitor)]
    response = call(world(visibility), visitor, method, path, body)
    assert response.status_code == expected, response.text[:300]


@pytest.mark.parametrize("visitor", VISITORS)
@pytest.mark.parametrize("case", list(TEAM_CASES), ids=case_id)
def test_team_endpoint(world, case, visitor):
    method, path, body, expected = TEAM_CASES[case]
    response = call(world("private"), visitor, method, path, body)
    assert response.status_code == expected[VISITORS.index(visitor)], response.text[:300]


def test_access_answer_names_the_role(world):
    for visibility in ("private", "public"):
        current = world(visibility)
        answers = {visitor: call(current, visitor, "GET", "/api/maps/{id}/access", None) for visitor in VISITORS}
        assert answers["owner"].json() == {"canWrite": True, "role": "owner"}
        assert answers["editor"].json() == {"canWrite": True, "role": "editor"}
        assert answers["reader"].json() == {"canWrite": False, "role": "reader"}
        if visibility == "public":
            assert answers["stranger"].json() == answers["anonymous"].json() == {"canWrite": False, "role": None}


def test_members_get_the_member_view(world):
    current = world("private")
    for visitor, can in (("owner", True), ("editor", True), ("reader", False)):
        body = call(current, visitor, "GET", "/api/maps/{id}/docs", None).json()
        assert body["canWrite"] is can
        meta = call(current, visitor, "GET", "/api/maps/{id}", None).json()
        assert meta["role"] == visitor and meta["ownerType"] == "team" and "id" in meta
    public = world("public")
    meta = call(public, "stranger", "GET", "/api/maps/{id}", None).json()
    assert "id" not in meta and "role" not in meta


def test_every_guarded_route_has_cases(app):
    """No endpoint escapes the matrix: each route below GUARDED matches at least one case of its method."""
    sample = {"id": str(uuid.uuid4()), "team": "team-x", "slug": "map-x", "share": str(uuid.uuid4()),
              "token": "x" * 32, "version": 1, "invitation": str(uuid.uuid4()), "invite_token": "x",
              "editor": "user-e", "reader": "user-r"}
    cases = [(method, fill(path, sample).split("?")[0])
             for method, path, *_ in list(MAP_CASES.values()) + list(TEAM_CASES.values())]
    missing = []
    for route in app.routes:
        if not isinstance(route, APIRoute) or not route.path.startswith(GUARDED):
            continue
        for method in route.methods:
            if not any(method == m and route.path_regex.match(p) for m, p in cases):
                missing.append(f"{method} {route.path}")
    assert missing == []
