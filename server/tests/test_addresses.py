"""The addresses of the maps (finding A5 of the final review, his answer of 2026-10-19): <BASE_URL>/<handle>/<slug> for a
map and <BASE_URL>/<handle> for the start map of an owner, else the list of its public maps. /u is gone. The reserved
names, which no handle can take because a handle shares the top-level paths with the site, and the names under the
wildcard that are no user site: www goes to the main domain with 308, and every other one gets 404."""
from __future__ import annotations

import json
import re

import pytest
from conftest import BASE, HEADERS, PASSWORD, count_rows, unique
from starlette.testclient import TestClient

from app.pages import site_policy
from app.security import RESERVED, handle_problem


def server_config(page: str) -> dict:
    match = re.search(r'<script type="application/json" id="it-skills-server">(.*?)</script>', page)
    assert match, page[:300]
    return json.loads(match[1])


def public_map(client, sample_file, title: str, visibility: str = "public") -> dict:
    created = client.post("/api/maps/import", json={**sample_file, "title": title}).json()
    if visibility != "private":
        created = client.patch(f"/api/maps/{created['id']}", json={"visibility": visibility}).json()
    return created


def new_team(client, handle=None):
    response = client.post("/api/teams", json={"name": "Team Start", "handle": handle or unique("t")})
    assert response.status_code == 201, response.text
    return response.json()


def add_member(pool, team_handle, client, role):
    with pool.connection() as conn:
        conn.execute("INSERT INTO memberships (organization_id, user_id, role) SELECT id, %s, %s FROM owners WHERE handle = %s",
                     (client.user_id, role, team_handle))


def start_of(pool, handle):
    with pool.connection() as conn:
        return conn.execute("SELECT start_map_id FROM owners WHERE handle = %s", (handle,)).fetchone()["start_map_id"]


def is_list(response, handle) -> bool:
    return response.status_code == 200 and 'id="it-skills-server"' not in response.text and f"<h1>{handle}</h1>" in response.text


def test_the_new_addresses_replace_u(quick_user, make_client, sample_file):
    anna = quick_user()
    created = public_map(anna, sample_file, "Pfad")
    assert created["pageUrl"] == f"{BASE}/{anna.handle}/{created['slug']}"
    assert created["ownerUrl"] == f"{BASE}/{anna.handle}" and created["start"] is False
    assert anna.get("/api/account").json()["profileUrl"] == f"{BASE}/{anna.handle}"
    assert anna.get(f"/api/public/{anna.handle}").json()["profileUrl"] == f"{BASE}/{anna.handle}"
    reader = make_client()
    page = reader.get(f"/{anna.handle}/{created['slug']}")
    assert page.status_code == 200 and server_config(page.text)["mode"] == "public"
    assert is_list(reader.get(f"/{anna.handle}"), anna.handle)
    # /u has no release yet, so it goes without a redirect.
    for path in (f"/u/{anna.handle}", f"/u/{anna.handle}/{created['slug']}"):
        assert reader.get(path, follow_redirects=False).status_code == 404, path


def test_the_owner_address_shows_the_start_map_while_it_is_public(quick_user, make_client, sample_file, pool):
    anna = quick_user()
    first = public_map(anna, sample_file, "Erste", "private")
    second = public_map(anna, sample_file, "Zweite")
    reader = make_client()
    assert is_list(reader.get(f"/{anna.handle}"), anna.handle)
    # A map that is not public can be the start map already. The address shows the list until it is public.
    changed = anna.patch(f"/api/maps/{first['id']}", json={"start": True})
    assert changed.status_code == 200 and changed.json()["start"] is True and changed.json()["version"] == first["version"] + 1
    assert anna.get(f"/api/maps/{first['id']}").json()["start"] is True
    assert str(start_of(pool, anna.handle)) == first["id"]
    listing = reader.get(f"/{anna.handle}")
    assert is_list(listing, anna.handle) and first["slug"] not in listing.text and second["slug"] in listing.text
    anna.patch(f"/api/maps/{first['id']}", json={"visibility": "public"})
    page = reader.get(f"/{anna.handle}")
    config = server_config(page.text)
    assert page.status_code == 200 and config["mode"] == "public" and config["map"]["slug"] == first["slug"]
    assert config["api"] == f"/api/public/{anna.handle}/{first['slug']}"
    # The owner gets his own map page there, with the write config.
    own = server_config(anna.get(f"/{anna.handle}").text)
    assert own["mode"] == "owner" and own["canWrite"] is True and own["api"] == f"/api/maps/{first['id']}"
    # The subdomain shows the same start map at "/".
    sub = reader.get("/", headers={"Host": f"{anna.handle}.it-skills.test"})
    assert sub.status_code == 200 and server_config(sub.text)["map"]["slug"] == first["slug"]
    # One start map per owner: a new pick replaces the one before.
    assert anna.patch(f"/api/maps/{second['id']}", json={"start": True}).json()["start"] is True
    maps = {m["slug"]: m["start"] for m in anna.get("/api/maps").json()["maps"]}
    assert maps == {first["slug"]: False, second["slug"]: True}
    assert server_config(reader.get(f"/{anna.handle}").text)["map"]["slug"] == second["slug"]
    # start false on a map that is not the start map changes nothing; on the start map it ends it.
    assert anna.patch(f"/api/maps/{first['id']}", json={"start": False}).json()["start"] is False
    assert str(start_of(pool, anna.handle)) == second["id"]
    assert anna.patch(f"/api/maps/{second['id']}", json={"start": False}).json()["start"] is False
    assert start_of(pool, anna.handle) is None and is_list(reader.get(f"/{anna.handle}"), anna.handle)
    # A start map that becomes private again: the address shows the list, and the choice stays.
    anna.patch(f"/api/maps/{second['id']}", json={"start": True})
    anna.patch(f"/api/maps/{second['id']}", json={"visibility": "link"})
    assert is_list(reader.get(f"/{anna.handle}"), anna.handle) and anna.get(f"/api/maps/{second['id']}").json()["start"] is True


def test_start_is_a_boolean_and_needs_the_right_to_share(quick_user, make_client, sample_file, pool):
    anna, bert, cleo = quick_user(), quick_user(), quick_user()
    team = new_team(anna)
    add_member(pool, team["handle"], bert, "editor")
    add_member(pool, team["handle"], cleo, "reader")
    created = anna.post("/api/maps", json={"title": "Teamkarte", "team": team["handle"]}).json()
    assert created["ownerUrl"] == f"{BASE}/{team['handle']}" and created["start"] is False
    for value in ("yes", 1, "true"):
        response = anna.patch(f"/api/maps/{created['id']}", json={"start": value})
        assert response.status_code == 422 and response.json()["error"] == "invalid_request", value
    # An editor writes the map, but the start map shows at the address of the team: that needs the right to share.
    assert bert.patch(f"/api/maps/{created['id']}", json={"start": True}).status_code == 403
    assert bert.patch(f"/api/maps/{created['id']}", json={"title": "Neu", "start": False}).status_code == 200
    assert cleo.patch(f"/api/maps/{created['id']}", json={"start": True}).status_code == 403
    assert quick_user().patch(f"/api/maps/{created['id']}", json={"start": True}).status_code == 404
    assert start_of(pool, team["handle"]) is None
    assert anna.patch(f"/api/maps/{created['id']}", json={"start": True, "visibility": "public"}).json()["start"] is True
    page = make_client().get(f"/{team['handle']}")
    assert page.status_code == 200 and server_config(page.text)["map"]["slug"] == created["slug"]
    member = server_config(bert.get(f"/{team['handle']}").text)
    assert member["mode"] == "owner" and member["role"] == "editor" and member["canShare"] is False
    team_maps = anna.get(f"/api/teams/{team['handle']}/maps").json()["maps"]
    assert [m["start"] for m in team_maps] == [True]


def test_a_move_into_a_team_clears_the_start_map_of_the_user(quick_user, make_client, sample_file, pool):
    anna = quick_user()
    team = new_team(anna)
    mine = public_map(anna, sample_file, "Wandert")
    anna.patch(f"/api/maps/{mine['id']}", json={"start": True})
    assert server_config(make_client().get(f"/{anna.handle}").text)["map"]["slug"] == mine["slug"]
    moved = anna.post(f"/api/maps/{mine['id']}/move", json={"team": team["handle"]})
    assert moved.status_code == 200 and moved.json()["start"] is False and moved.json()["ownerUrl"] == f"{BASE}/{team['handle']}"
    assert start_of(pool, anna.handle) is None and start_of(pool, team["handle"]) is None
    # Without a public map, the address is a 404 for a reader, as for an unknown handle (finding A7), and the list for the
    # owner.
    assert make_client().get(f"/{anna.handle}").status_code == 404 and is_list(anna.get(f"/{anna.handle}"), anna.handle)
    assert anna.get(f"/api/maps/{mine['id']}").json()["start"] is False


def test_a_deleted_start_map_and_deleted_owners(quick_user, make_client, sample_file, pool):
    anna = quick_user()
    gone = public_map(anna, sample_file, "Weg")
    anna.patch(f"/api/maps/{gone['id']}", json={"start": True})
    assert anna.delete(f"/api/maps/{gone['id']}").status_code == 204
    assert start_of(pool, anna.handle) is None and make_client().get(f"/{anna.handle}").status_code == 404
    assert is_list(anna.get(f"/{anna.handle}"), anna.handle)
    # An account and a team with a start map go as before.
    team = new_team(anna)
    team_map = anna.post("/api/maps", json={"title": "Team", "team": team["handle"], "visibility": "public"}).json()
    anna.patch(f"/api/maps/{team_map['id']}", json={"start": True})
    assert anna.post(f"/api/teams/{team['handle']}/delete", json={"password": PASSWORD}).status_code == 204
    kept = public_map(anna, sample_file, "Bleibt")
    anna.patch(f"/api/maps/{kept['id']}", json={"start": True})
    assert anna.post("/api/account/delete", json={"password": PASSWORD}).status_code == 204
    assert count_rows(pool, "owners") == 0 and count_rows(pool, "maps") == 0
    assert make_client().get(f"/{anna.handle}").status_code == 404


def test_an_owner_without_a_public_map_answers_as_an_unknown_handle(quick_user, make_client, sample_file, pool):
    """Finding A7 of the final review: the address of an owner and /api/public/<handle> gave 200 with an empty list for
    every confirmed account, so anyone could test whether a person has an account. Now an owner without a public map
    gets the answer of an unknown handle, byte for byte. Only the owner and the members of a team get the empty list."""
    anna, bert = quick_user(), quick_user()
    team = new_team(anna)
    add_member(pool, team["handle"], bert, "reader")
    public_map(anna, sample_file, "Privat", "private")
    anna.post("/api/maps", json={"title": "Geteilt", "team": team["handle"], "visibility": "link"})
    unknown = unique()

    def answer(client, path, host=None):
        response = client.get(path, headers={"Host": host} if host else {}, follow_redirects=False)
        return response.status_code, dict(response.headers), response.content

    for client in (make_client(), quick_user()):
        for handle in (anna.handle, team["handle"]):
            for path in ("/{}", "/api/public/{}"):
                got, want = answer(client, path.format(handle)), answer(client, path.format(unknown))
                assert got == want and got[0] == 404, (handle, path)
            assert answer(client, "/", f"{handle}.it-skills.test") == answer(client, "/", f"{unknown}.it-skills.test")
    assert is_list(anna.get(f"/{anna.handle}"), anna.handle)
    for member in (anna, bert):
        assert is_list(member.get(f"/{team['handle']}"), "Team Start")
    # The reader API never reads the session: it is a 404 for the owner too.
    assert anna.get(f"/api/public/{anna.handle}").status_code == 404
    # A public map makes the list visible for everyone.
    shown = public_map(anna, sample_file, "Offen")
    reader = make_client()
    assert is_list(reader.get(f"/{anna.handle}"), anna.handle)
    assert [m["slug"] for m in reader.get(f"/api/public/{anna.handle}").json()["maps"]] == [shown["slug"]]


def test_the_own_handle_on_its_subdomain_goes_to_the_root(quick_user, make_client, sample_file):
    """On a subdomain, /<the handle of the subdomain> was read as the slug of a map, so it gave 404 unless a map had that
    slug. A map with that slug still wins. Else the answer is a 308 to "/" of the subdomain."""
    anna, reader = quick_user(), make_client()
    host, root = {"Host": f"{anna.handle}.it-skills.test"}, f"https://{anna.handle}.it-skills.test/"
    for path, location in ((f"/{anna.handle}", root), (f"/{anna.handle}?theme=dark&x=%C3%A4", root + "?theme=dark&x=%C3%A4")):
        response = reader.get(path, headers=host, follow_redirects=False)
        assert response.status_code == 308 and response.headers["location"] == location, path
        assert response.headers["content-security-policy"] == site_policy("'self'")
    assert reader.get("/no-such-map", headers=host, follow_redirects=False).status_code == 404
    assert reader.get(f"/{unique()}", headers=host, follow_redirects=False).status_code == 404
    # A map with the slug of the handle wins, for every visitor who may read it.
    named = anna.post("/api/maps", json={"title": "Wie der Name", "slug": anna.handle, "visibility": "public"}).json()
    page = reader.get(f"/{anna.handle}", headers=host, follow_redirects=False)
    assert page.status_code == 200 and server_config(page.text)["map"]["slug"] == anna.handle
    # A private map with that slug: the owner gets it, and a reader gets the 308, so nobody learns that it exists.
    anna.patch(f"/api/maps/{named['id']}", json={"visibility": "private"})
    assert reader.get(f"/{anna.handle}", headers=host, follow_redirects=False).headers["location"] == root
    own = anna.get(f"/{anna.handle}", headers=host, follow_redirects=False)
    assert own.status_code == 200 and server_config(own.text)["mode"] == "owner"


def test_a_slash_at_the_end_never_leads_to_http_or_another_host(app, quick_user, sample_file):
    """Finding B3 of the final review: Starlette answered a path with a "/" at the end with a 307 to the address without
    it, built from the request. The proxy talks plain HTTP to the app, and uvicorn runs with --no-proxy-headers, so the
    redirect named http:// and the whole path, for example the token of a read link. The client here talks http:// to the
    app, as the proxy does. A page gets a 308 to BASE_URL or to its subdomain. The API gets a 404."""
    anna = quick_user()
    created = public_map(anna, sample_file, "Schraeg")
    token = anna.post(f"/api/maps/{created['id']}/shares").json()["token"]
    proxy = TestClient(app, base_url="http://it-skills.test")
    slug = created["slug"]
    pages = {f"/{anna.handle}/": f"/{anna.handle}", f"/{anna.handle}//": f"/{anna.handle}",
             f"/{anna.handle}/{slug}/": f"/{anna.handle}/{slug}", f"/s/{token}/": f"/s/{token}",
             f"/e/s/{token}/?lang=de": f"/e/s/{token}?lang=de", f"/e/{anna.handle}/{slug}/": f"/e/{anna.handle}/{slug}",
             "/account/": "/account", "/index.html/": "/index.html"}
    for path, target in pages.items():
        for host in (None, "evil.example", "it-skills.test:8080"):
            response = proxy.get(path, headers={"Host": host} if host else {}, follow_redirects=False)
            assert response.status_code == 308 and response.headers["location"] == BASE + target, (path, host)
            assert response.headers["x-frame-options"] == "SAMEORIGIN"
    response = proxy.get(f"/{slug}/", headers={"Host": f"{anna.handle}.it-skills.test"}, follow_redirects=False)
    assert response.status_code == 308 and response.headers["location"] == f"https://{anna.handle}.it-skills.test/{slug}"
    for path in (f"/api/shared/{token}/docs/", f"/api/shared/{token}/", f"/api/public/{anna.handle}/", "/api/maps/",
                 "/api/health/", "/api/"):
        response = proxy.get(path, follow_redirects=False)
        assert response.status_code == 404 and response.json()["error"] == "not_found", path
        assert "location" not in response.headers and response.headers["cache-control"] == "no-store", path
    # A path that no route takes without the slash, and a write, get no redirect either.
    assert proxy.get("/a/b/c/", follow_redirects=False).status_code == 404
    response = proxy.post(f"/{anna.handle}/", headers={**HEADERS, "Origin": BASE}, follow_redirects=False)
    assert response.status_code in (404, 405) and "location" not in response.headers


@pytest.mark.parametrize("name", ["vendor", "index", "example", "map", "server-map", "imprint", "privacy", "assets", "api",
                                  "account"])
def test_the_top_level_names_of_the_site_and_the_app_are_no_handles(name, client, quick_user):
    assert name in RESERVED and handle_problem(name).code == "reserved_handle"
    response = client.post("/api/auth/register", json={"email": f"{unique()}@example.org", "password": PASSWORD, "handle": name})
    assert response.status_code == 400 and response.json()["error"] == "reserved_handle"
    response = quick_user().post("/api/teams", json={"name": "Reserviert", "handle": name})
    assert response.status_code == 400 and response.json()["error"] == "reserved_handle"


def test_a_top_level_path_that_is_no_handle_is_a_404(client):
    for path in ("/vendor", "/index", "/example", "/Anna", "/an", "/favicon.ico", "/a--b", "/vendor/d3.js", "/assets/x"):
        response = client.get(path)
        assert response.status_code == 404 and response.headers["content-type"].startswith("text/html"), path
    # /api/<unknown> stays a 404 of the API for every method: no route of an address takes it.
    for method in ("GET", "POST", "PUT", "PATCH", "DELETE"):
        response = client.request(method, "/api/nothing", json={} if method != "GET" else None)
        assert response.status_code == 404 and response.json()["error"] == "not_found", method


def test_www_under_the_wildcard_goes_to_the_main_domain(client, quick_user):
    www = {"Host": "www.it-skills.test"}
    for path in ("/", "/anna/karte?theme=dark&x=%C3%A4", "/api/health", "/assets/site.css"):
        response = client.get(path, headers=www, follow_redirects=False)
        assert response.status_code == 308 and response.headers["location"] == BASE + path, path
    # A write keeps its method through the 308, and the redirect comes before the CSRF check.
    response = client.post("/api/maps", json={"title": "x"}, headers={**HEADERS, **www}, follow_redirects=False)
    assert response.status_code == 308 and response.headers["location"] == f"{BASE}/api/maps"
    assert response.headers["x-content-type-options"] == "nosniff"


def test_www_is_no_redirect_when_it_is_the_main_host(make_app, make_client):
    client = make_client(make_app(base_url="https://www.it-skills.test"), headers={**HEADERS, "Origin": "https://www.it-skills.test"})
    page = client.get("/", headers={"Host": "www.it-skills.test"}, follow_redirects=False)
    assert page.status_code == 200 and server_config(page.text)["mode"] == "site"
    response = client.post("/api/auth/logout", headers={"Host": "www.it-skills.test"})
    assert response.status_code == 204


@pytest.mark.parametrize("label", ["api", "account", "mail", "vendor", "static", "x", "a--b", "my_site"])
def test_every_other_name_under_the_wildcard_that_is_no_handle_gets_404(label, client, quick_user):
    anna = quick_user()
    host = {"Host": f"{label}.it-skills.test"}
    for path in ("/", "/index.html", f"/{anna.handle}", "/account", "/assets/site.css", "/s/token"):
        response = client.get(path, headers=host, follow_redirects=False)
        assert response.status_code == 404 and response.headers["content-type"].startswith("text/html"), path
        assert response.headers["content-security-policy"].endswith("frame-ancestors 'self'"), path
    for method, path in (("GET", "/api/health"), ("GET", "/api/account"), ("POST", "/api/maps"), ("POST", "/api/auth/login")):
        response = anna.request(method, path, headers=host, json={} if method == "POST" else None)
        assert response.status_code == 404 and response.json()["error"] == "not_found", (method, path)
