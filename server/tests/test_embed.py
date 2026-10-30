"""The embed view of a map (/e/<handle>/<slug> and /e/s/<token>), its framing headers, the embed setting of a map in
the API, and the framing headers of every other page. The last tests cover the maps of a team: only an owner of the
team changes the embed setting, and the embed view works for a public team map and for a share link of a team map."""
from __future__ import annotations

import json
import re
from types import SimpleNamespace

import pytest
from conftest import BASE, unique

from app.pages import site_policy
from app.store import MAX_EMBED_ORIGINS, check_origin

# The text of the page of an embed address without a map, with its key (server/app/pages.py).
EMBED_MISSING = '<p data-i18n="server.embedMissing.text">Not found. This map does not exist, or it is no longer shared.</p>'


@pytest.fixture
def owner(client, signup):
    client.account = signup(client)
    return client


@pytest.fixture
def filled_map(owner, sample_file):
    return owner.post("/api/maps/import", json=sample_file).json()


def server_config(page: str) -> dict:
    match = re.search(r'<script type="application/json" id="it-skills-server">(.*?)</script>', page)
    assert match, page[:300]
    return json.loads(match[1])


def publish(owner, map_row, visibility="public"):
    response = owner.patch(f"/api/maps/{map_row['id']}", json={"visibility": visibility})
    assert response.status_code == 200, response.text
    return response.json()


def embed(owner, map_row, **change):
    return owner.patch(f"/api/maps/{map_row['id']}", json={"embed": change})


def test_new_map_lets_every_site_embed(owner, filled_map):
    assert filled_map["embed"] == {"allow": "all", "origins": [], "url": None}
    created = owner.post("/api/maps", json={"title": "Neu"}).json()
    assert created["embed"] == {"allow": "all", "origins": [], "url": None}
    public = publish(owner, filled_map)
    assert public["embed"]["url"] == f"{BASE}/e/{owner.account['handle']}/{filled_map['slug']}"
    assert publish(owner, filled_map, "link")["embed"]["url"] is None
    listed = owner.get("/api/maps").json()["maps"]
    assert all("embed" in m for m in listed)


def test_embed_view_of_a_public_map(owner, filled_map, make_client):
    handle, slug = owner.account["handle"], filled_map["slug"]
    reader = make_client()
    assert reader.get(f"/e/{handle}/{slug}").status_code == 404
    publish(owner, filled_map)
    page = reader.get(f"/e/{handle}/{slug}")
    assert page.status_code == 200 and "Testseite der Karte" in page.text
    assert page.headers["content-security-policy"] == site_policy("*")
    assert "x-frame-options" not in page.headers
    assert page.headers["cache-control"] == "no-store" and page.headers["referrer-policy"] == "no-referrer"
    assert "set-cookie" not in page.headers
    config = server_config(page.text)
    assert config == {"mode": "embed", "api": f"/api/public/{handle}/{slug}", "canWrite": False,
                      "map": {"title": filled_map["title"], "slug": slug, "owner": handle, "visibility": "public"},
                      "account": f"{BASE}/account", "language": None, "embed": {"open": f"{BASE}/{handle}/{slug}"}}
    assert reader.get(config["api"] + "/docs").json()["canWrite"] is False


def test_embed_view_ignores_the_session_of_the_owner(owner, filled_map):
    handle, slug = owner.account["handle"], filled_map["slug"]
    # The owner sees his private map at /..., but its embed address is a 404 for him too.
    assert owner.get(f"/{handle}/{slug}").status_code == 200
    missing = owner.get(f"/e/{handle}/{slug}")
    assert missing.status_code == 404 and "set-cookie" not in missing.headers
    publish(owner, filled_map)
    page = owner.get(f"/e/{handle}/{slug}")
    config = server_config(page.text)
    assert config["mode"] == "embed" and config["canWrite"] is False and config["api"] == f"/api/public/{handle}/{slug}"
    assert "set-cookie" not in page.headers


def test_embed_view_of_a_map_that_is_not_public_is_a_frameable_404(owner, filled_map, make_client):
    handle, slug = owner.account["handle"], filled_map["slug"]
    reader = make_client()
    for visibility in ("private", "link"):
        publish(owner, filled_map, visibility)
        page = reader.get(f"/e/{handle}/{slug}")
        assert page.status_code == 404 and 'id="it-skills-server"' not in page.text, visibility
        assert EMBED_MISSING in page.text and page.headers["content-security-policy"] == site_policy("*")
    for path in ("/e/nobody-here/x", f"/e/{handle}/missing", "/e/s/not-a-real-token", f"/e/{handle}"):
        assert reader.get(path).status_code == 404, path


def test_embed_view_of_a_share_link(owner, filled_map, make_client):
    map_id = filled_map["id"]
    share = owner.post(f"/api/maps/{map_id}/shares").json()
    assert share["embedUrl"] == f"{BASE}/e/s/{share['token']}"
    reader = make_client()
    page = reader.get(f"/e/s/{share['token']}")
    assert page.status_code == 200 and page.headers["content-security-policy"] == site_policy("*")
    assert page.headers["referrer-policy"] == "no-referrer" and "x-frame-options" not in page.headers
    config = server_config(page.text)
    assert config["mode"] == "embed" and config["api"] == f"/api/shared/{share['token']}"
    assert config["embed"] == {"open": f"{BASE}/s/{share['token']}"}
    # A private map turns the link off, and so its embed view.
    publish(owner, filled_map, "private")
    assert reader.get(f"/e/s/{share['token']}").status_code == 404
    publish(owner, filled_map, "link")
    assert reader.get(f"/e/s/{share['token']}").status_code == 200
    # A new link revokes the old one, and so the frame of the old link.
    renewed = owner.post(f"/api/maps/{map_id}/shares", json={"replace": True}).json()
    gone = reader.get(f"/e/s/{share['token']}")
    assert gone.status_code == 404 and EMBED_MISSING in gone.text
    assert reader.get(f"/e/s/{renewed['token']}").status_code == 200


def test_origin_list(owner, filled_map, make_client):
    handle, slug = owner.account["handle"], filled_map["slug"]
    publish(owner, filled_map)
    response = embed(owner, filled_map, allow="origins", origins=["https://Example.org/", "http://127.0.0.1:5173",
                                                                   "https://example.org:443", "https://cv.example.net"])
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["embed"]["allow"] == "origins"
    assert result["embed"]["origins"] == ["https://example.org", "http://127.0.0.1:5173", "https://cv.example.net"]
    assert result["version"] == filled_map["version"] + 2
    assert owner.get(f"/api/maps/{filled_map['id']}").json()["embed"]["origins"] == result["embed"]["origins"]
    page = make_client().get(f"/e/{handle}/{slug}")
    assert page.headers["content-security-policy"] == site_policy("'self' https://example.org http://127.0.0.1:5173 https://cv.example.net")
    # Back to every site: the list stays for the next switch.
    back = embed(owner, filled_map, allow="all").json()
    assert back["embed"] == {"allow": "all", "origins": result["embed"]["origins"], "url": result["embed"]["url"]}
    assert make_client().get(f"/e/{handle}/{slug}").headers["content-security-policy"] == site_policy("*")
    # An empty list with "origins": only the site itself may frame the view.
    embed(owner, filled_map, allow="origins", origins=[])
    assert make_client().get(f"/e/{handle}/{slug}").headers["content-security-policy"] == site_policy("'self'")


def test_origin_list_rejects_bad_values(owner, filled_map):
    for origin in ("example.org", "https://example.org/cv", "https://example.org?x=1", "ftp://example.org",
                   "https://*.example.org", "https://a b.org", "https://ex;ample.org", "https://example.org:99999",
                   "https://user@example.org", "https://[::1]", "javascript:alert(1)", "", "https://-x.org", "https://intranet",
                   "https://" + "a" * 200 + ".org"):
        response = embed(owner, filled_map, allow="origins", origins=[origin])
        assert response.status_code == 400 and response.json()["error"] == "invalid_origin", origin
    response = embed(owner, filled_map, allow="some")
    assert response.status_code == 400 and response.json()["error"] == "invalid_embed"
    many = [f"https://site{i}.example.org" for i in range(MAX_EMBED_ORIGINS + 1)]
    response = embed(owner, filled_map, origins=many)
    assert response.status_code == 400 and response.json()["error"] == "too_many_origins"
    assert embed(owner, filled_map, origins=many[:MAX_EMBED_ORIGINS]).status_code == 200
    response = embed(owner, filled_map, origins=[1])
    assert response.status_code == 422
    # Nothing of the failed changes was stored.
    assert owner.get(f"/api/maps/{filled_map['id']}").json()["embed"]["allow"] == "all"


def test_only_the_owner_changes_the_embed_setting(owner, filled_map, make_client, signup):
    publish(owner, filled_map)
    other = make_client()
    assert other.patch(f"/api/maps/{filled_map['id']}", json={"embed": {"allow": "origins"}}).status_code == 401
    signup(other)
    assert other.patch(f"/api/maps/{filled_map['id']}", json={"embed": {"allow": "origins"}}).status_code == 404
    reader_view = other.get(f"/api/maps/{filled_map['id']}").json()
    assert "embed" not in reader_view and "id" not in reader_view
    assert "embed" not in other.get(f"/api/public/{owner.account['handle']}/{filled_map['slug']}").json()


def test_check_origin():
    assert check_origin(" HTTPS://Example.ORG ") == "https://example.org"
    assert check_origin("http://localhost:80") == "http://localhost"
    assert check_origin("http://localhost:8080/") == "http://localhost:8080"
    assert check_origin("http://127.0.0.1:5173") == "http://127.0.0.1:5173"
    assert check_origin("https://xn--bcher-kva.example") == "https://xn--bcher-kva.example"


def test_no_other_page_may_be_framed_by_another_site(owner, filled_map, make_client):
    handle, slug = owner.account["handle"], filled_map["slug"]
    share = owner.post(f"/api/maps/{filled_map['id']}/shares").json()
    publish(owner, filled_map)
    reader = make_client()
    host = {"Host": f"{handle}.it-skills.test"}
    pages = {
        "public map": reader.get(f"/{handle}/{slug}"),
        "share link": reader.get(f"/s/{share['token']}"),
        "list of a user": reader.get(f"/{handle}"),
        "start page": reader.get("/"),
        "subdomain map": reader.get(f"/{slug}", headers=host),
        "subdomain list": reader.get("/", headers=host),
        "owner page": owner.get(f"/{handle}/{slug}"),
        "missing page": reader.get("/nobody-here"),
        "api": reader.get(f"/api/public/{handle}/{slug}/docs"),
    }
    for name, page in pages.items():
        assert page.headers["content-security-policy"] == site_policy("'self'"), name
        assert page.headers["x-frame-options"] == "SAMEORIGIN", name
    konto = reader.get("/account")
    assert "frame-ancestors 'none'" in konto.headers["content-security-policy"] and konto.headers["x-frame-options"] == "DENY"
    # The subdomains have no embed view.
    assert reader.get(f"/e/{handle}/{slug}", headers=host).status_code == 404


# --- Maps of a team ----------------------------------------------------------------------------------------------

@pytest.fixture
def team_world(quick_user, pool, sample_file):
    """A team with an owner, an editor and a reader, a signed-in user who is no member, and a map of the team."""
    owner, editor, reader, stranger = (quick_user() for _ in range(4))
    handle = unique("t")
    assert owner.post("/api/teams", json={"name": "Team", "handle": handle}).status_code == 201
    with pool.connection() as conn:
        for member, role in ((editor, "editor"), (reader, "reader")):
            conn.execute("INSERT INTO memberships (organization_id, user_id, role) SELECT id, %s, %s FROM owners"
                         " WHERE handle = %s", (member.user_id, role, handle))
    created = owner.post(f"/api/maps/import?team={handle}", json=sample_file)
    assert created.status_code == 201, created.text
    return SimpleNamespace(owner=owner, editor=editor, reader=reader, stranger=stranger, team=handle, map=created.json())


def test_only_a_team_owner_changes_the_embed_setting_of_a_team_map(team_world):
    w = team_world
    path = f"/api/maps/{w.map['id']}"
    change = {"embed": {"allow": "origins", "origins": ["https://team.example.org"]}}
    for client, status in ((w.editor, 403), (w.reader, 403), (w.stranger, 404)):
        response = client.patch(path, json=change)
        assert response.status_code == status, (status, response.text)
        if status == 403:
            assert response.json()["error"] == "forbidden"
    assert w.owner.get(path).json()["embed"] == {"allow": "all", "origins": [], "url": None}
    response = w.owner.patch(path, json=change)
    assert response.status_code == 200, response.text
    assert response.json()["embed"]["origins"] == ["https://team.example.org"]
    # A change that keeps the embed setting as it is needs only the right to write.
    kept = w.editor.patch(path, json={"title": "Neuer Titel", "embed": {"allow": "origins"}})
    assert kept.status_code == 200 and kept.json()["embed"]["origins"] == ["https://team.example.org"]
    assert w.editor.patch(path, json={"embed": {"allow": "all"}}).status_code == 403
    assert w.owner.get(path).json()["embed"]["allow"] == "origins"


def test_embed_view_of_a_public_team_map(team_world, make_client):
    w = team_world
    slug = w.map["slug"]
    reader = make_client()
    assert reader.get(f"/e/{w.team}/{slug}").status_code == 404
    public = publish(w.owner, w.map)
    assert public["embed"]["url"] == f"{BASE}/e/{w.team}/{slug}"
    page = reader.get(f"/e/{w.team}/{slug}")
    assert page.status_code == 200 and page.headers["content-security-policy"] == site_policy("*")
    assert "set-cookie" not in page.headers
    config = server_config(page.text)
    assert config == {"mode": "embed", "api": f"/api/public/{w.team}/{slug}", "canWrite": False,
                      "map": {"title": w.map["title"], "slug": slug, "owner": w.team, "visibility": "public"},
                      "account": f"{BASE}/account", "language": None, "embed": {"open": f"{BASE}/{w.team}/{slug}"}}
    # The embed view ignores the session of a member: it gives the reader view, and nothing of a private map.
    member = server_config(w.editor.get(f"/e/{w.team}/{slug}").text)
    assert member["mode"] == "embed" and member["canWrite"] is False and "role" not in member
    publish(w.owner, w.map, "private")
    assert w.owner.get(f"/e/{w.team}/{slug}").status_code == 404


def test_embed_view_of_a_share_link_of_a_team_map(team_world, make_client):
    w = team_world
    share = w.owner.post(f"/api/maps/{w.map['id']}/shares").json()
    assert share["embedUrl"] == f"{BASE}/e/s/{share['token']}"
    reader = make_client()
    page = reader.get(f"/e/s/{share['token']}")
    assert page.status_code == 200 and page.headers["content-security-policy"] == site_policy("*")
    assert "set-cookie" not in page.headers
    config = server_config(page.text)
    assert config["mode"] == "embed" and config["api"] == f"/api/shared/{share['token']}"
    assert config["map"]["owner"] == w.team and config["embed"] == {"open": f"{BASE}/s/{share['token']}"}
    publish(w.owner, w.map, "private")
    assert reader.get(f"/e/s/{share['token']}").status_code == 404


def test_team_map_page_sends_the_share_right(team_world):
    w = team_world
    for client, role, can_write, can_share in ((w.owner, "owner", True, True), (w.editor, "editor", True, False),
                                               (w.reader, "reader", False, False)):
        config = server_config(client.get(f"/{w.team}/{w.map['slug']}").text)
        assert (config["mode"], config["role"], config["canWrite"], config["canShare"]) == (
            "owner", role, can_write, can_share), role
