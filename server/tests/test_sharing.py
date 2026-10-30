"""Share links, public maps by path and by Host header, and the pages that the app serves."""
from __future__ import annotations

import json
import re

import psycopg
import pytest
from conftest import BASE, Background, count_rows, wait_for_locks

from app.pages import site_policy
from app.security import hash_token


@pytest.fixture
def owner(client, signup):
    account = signup(client)
    client.account = account
    return client


@pytest.fixture
def filled_map(owner, sample_file):
    return owner.post("/api/maps/import", json=sample_file).json()


def server_config(page: str) -> dict:
    match = re.search(r'<script type="application/json" id="it-skills-server">(.*?)</script>', page)
    assert match, page[:300]
    return json.loads(match[1])


def test_share_link_is_read_only_and_revocable(owner, filled_map, make_client, signup, pool):
    map_id = filled_map["id"]
    response = owner.post(f"/api/maps/{map_id}/shares")
    assert response.status_code == 201
    share = response.json()
    assert share["visibility"] == "link" and share["url"] == f"{BASE}/s/{share['token']}"
    assert share["mode"] == "read" and share["embedUrl"] == f"{BASE}/e/s/{share['token']}"
    assert len(share["token"]) >= 22  # 24 random bytes, more than 128 bits
    # A reader finds the link by the hash of its token. The server keeps the token too, for the owner.
    with pool.connection() as conn:
        row = conn.execute("SELECT token_hash, token FROM share_links WHERE id = %s", (share["id"],)).fetchone()
    assert bytes(row["token_hash"]) == hash_token(share["token"]) and row["token"] == share["token"]
    listed = owner.get(f"/api/maps/{map_id}/shares").json()
    assert listed == {"visibility": "link", "shares": [{k: v for k, v in share.items() if k != "visibility"}]}

    reader = make_client()
    docs = reader.get(f"/api/shared/{share['token']}/docs").json()
    assert docs["canWrite"] is False and len(docs["docs"]) == len(owner.get(f"/api/maps/{map_id}/docs").json()["docs"])
    assert reader.get(f"/api/shared/{share['token']}/docs", params={"since": docs["version"]}).status_code == 304
    assert reader.get(f"/api/shared/{share['token']}/access").json() == {"canWrite": False}
    meta = reader.get(f"/api/shared/{share['token']}").json()
    assert meta["title"] == filled_map["title"] and "id" not in meta
    # A reader with the link cannot write, signed in or not.
    assert reader.put(f"/api/maps/{map_id}/docs/skills/x", json={"name": "X"}).status_code == 401
    signup(reader)
    assert reader.put(f"/api/maps/{map_id}/docs/skills/x", json={"name": "X"}).status_code == 404
    # Nor can the reader make a new link, which would revoke the link of the owner.
    assert reader.post(f"/api/maps/{map_id}/shares").status_code == 404
    assert reader.get(f"/api/shared/{share['token']}/docs").status_code == 200

    page = reader.get(f"/s/{share['token']}")
    assert page.status_code == 200 and page.headers["referrer-policy"] == "no-referrer"
    config = server_config(page.text)
    assert config["mode"] == "shared" and config["canWrite"] is False
    assert config["api"] == f"/api/shared/{share['token']}"

    # The owner revokes the link by making a new one. The old token stops working at once.
    renewed = owner.post(f"/api/maps/{map_id}/shares", json={"replace": True}).json()
    assert renewed["token"] != share["token"] and renewed["id"] != share["id"]
    assert reader.get(f"/api/shared/{share['token']}/docs").status_code == 404
    assert reader.get(f"/s/{share['token']}").status_code == 404
    assert [s["token"] for s in owner.get(f"/api/maps/{map_id}/shares").json()["shares"]] == [renewed["token"]]
    # No route revokes a link without a new one.
    assert owner.delete(f"/api/maps/{map_id}/shares/{renewed['id']}").status_code == 404
    assert reader.get(f"/api/shared/{renewed['token']}/docs").status_code == 200


def test_private_map_turns_its_links_off(owner, filled_map, make_client):
    """Private pauses the link: it gives 404 everywhere, and "link" or "public" makes the same link work again. The
    owner still sees the paused link and can copy it."""
    map_id = filled_map["id"]
    share = owner.post(f"/api/maps/{map_id}/shares").json()
    token = share["token"]
    reader = make_client()
    paths = (f"/api/shared/{token}", f"/api/shared/{token}/docs", f"/api/shared/{token}/access", f"/s/{token}",
             f"/e/s/{token}")
    assert all(reader.get(path).status_code == 200 for path in paths)
    owner.patch(f"/api/maps/{map_id}", json={"visibility": "private"})
    for path in paths:
        assert reader.get(path).status_code == 404, path
    paused = owner.get(f"/api/maps/{map_id}/shares").json()
    assert paused["visibility"] == "private" and [s["url"] for s in paused["shares"]] == [share["url"]]
    for visibility in ("link", "public"):
        owner.patch(f"/api/maps/{map_id}", json={"visibility": visibility})
        for path in paths:
            assert reader.get(path).status_code == 200, (visibility, path)
    assert owner.get(f"/api/maps/{map_id}/shares").json()["shares"] == paused["shares"]
    assert reader.get("/api/shared/not-a-real-token/docs").status_code == 404


def test_a_map_has_one_read_link_that_the_owner_gets_again(owner, filled_map, pool):
    """His decision of 2026-10-19: one read link per map. GET gives the same link every time, with its token, its
    address and its embed address, so that the owner can copy it again."""
    map_id = filled_map["id"]
    assert owner.get(f"/api/maps/{map_id}/shares").json() == {"visibility": "private", "shares": []}
    share = owner.post(f"/api/maps/{map_id}/shares").json()
    first = owner.get(f"/api/maps/{map_id}/shares").json()["shares"]
    again = owner.get(f"/api/maps/{map_id}/shares").json()["shares"]
    assert first == again and len(first) == 1
    assert {key: first[0][key] for key in ("id", "token", "url", "embedUrl", "created")} == \
        {key: share[key] for key in ("id", "token", "url", "embedUrl", "created")}
    assert count_rows(pool, "share_links", "map_id = %s", (map_id,)) == 1
    maps = {m["id"]: m for m in owner.get("/api/maps").json()["maps"]}
    assert maps[map_id]["shares"] == 1
    # The database holds the rule too: a second link of the same map is refused.
    with pool.connection() as conn, pytest.raises(psycopg.errors.UniqueViolation):
        conn.execute("INSERT INTO share_links (map_id, token_hash, token) VALUES (%s, %s, 'zweiter-link')",
                     (map_id, hash_token("zweiter-link")))


def test_a_new_link_revokes_the_old_one_at_once(owner, filled_map, make_client, pool):
    """POST on a map with a link revokes it and makes a new one, in one transaction. The old token gets 404 at the
    map page, at the embed view and at the API at once, and only the new link is left."""
    map_id = filled_map["id"]
    old = owner.post(f"/api/maps/{map_id}/shares").json()
    reader = make_client()
    reader.get(f"/s/{old['token']}")
    new = owner.post(f"/api/maps/{map_id}/shares", json={"replace": True})
    assert new.status_code == 201
    new = new.json()
    assert new["token"] != old["token"] and new["visibility"] == "link"
    for token, status in ((old["token"], 404), (new["token"], 200)):
        for path in (f"/s/{token}", f"/e/s/{token}", f"/api/shared/{token}", f"/api/shared/{token}/docs",
                     f"/api/shared/{token}/access"):
            assert reader.get(path).status_code == status, path
    assert [s["id"] for s in owner.get(f"/api/maps/{map_id}/shares").json()["shares"]] == [new["id"]]
    assert count_rows(pool, "share_links", "map_id = %s", (map_id,)) == 1


def test_two_new_links_at_the_same_moment_leave_one(quick_user, make_client, sample_file, pool, database):
    """Two requests for a new link at the same moment: both wait for the row lock on the map, the second replaces the
    link of the first, and exactly one link is left. Its token is the only one that works."""
    anna = quick_user()
    map_id = anna.post("/api/maps/import", json=sample_file).json()["id"]
    twin = make_client(cookies={"__Host-session": anna.cookies.get("__Host-session")})
    with psycopg.connect(database) as hold:
        hold.execute("SELECT id FROM maps WHERE id = %s FOR UPDATE", (map_id,))
        calls = [Background(lambda c=c: c.post(f"/api/maps/{map_id}/shares", json={"replace": True})) for c in (anna, twin)]
        wait_for_locks(pool, 2)
        hold.rollback()
    answers = [call.result() for call in calls]
    assert [a.status_code for a in answers] == [201, 201]
    assert count_rows(pool, "share_links", "map_id = %s", (map_id,)) == 1
    kept = anna.get(f"/api/maps/{map_id}/shares").json()["shares"]
    assert len(kept) == 1 and kept[0]["token"] in {a.json()["token"] for a in answers}
    reader = make_client()
    for answer in answers:
        token = answer.json()["token"]
        assert reader.get(f"/api/shared/{token}/docs").status_code == (200 if token == kept[0]["token"] else 404)


def test_a_post_gives_the_link_that_the_map_has(owner, filled_map, make_client, pool):
    """POST .../shares gave a new link every time, so an API client that posted to get the link revoked it. Now a map
    with a link gets that link back with 200, and only {"replace": true} revokes it and makes a new one, with 201
    ("Revoke and generate new link")."""
    map_id = filled_map["id"]
    first = owner.post(f"/api/maps/{map_id}/shares")
    assert first.status_code == 201 and first.json()["visibility"] == "link"
    for body in (None, {}, {"replace": False}):
        again = owner.post(f"/api/maps/{map_id}/shares", **({} if body is None else {"json": body}))
        assert again.status_code == 200 and again.json() == first.json(), body
    reader = make_client()
    assert reader.get(f"/api/shared/{first.json()['token']}/docs").status_code == 200
    for value in ("yes", 1, None, "true"):
        response = owner.post(f"/api/maps/{map_id}/shares", json={"replace": value})
        assert response.status_code == 422 and response.json()["error"] == "invalid_request", value
    # A private map pauses its link. A POST without replace shares it by link again, with the same link.
    owner.patch(f"/api/maps/{map_id}", json={"visibility": "private"})
    paused = owner.post(f"/api/maps/{map_id}/shares")
    assert paused.status_code == 200 and paused.json()["token"] == first.json()["token"]
    assert paused.json()["visibility"] == "link"
    assert reader.get(f"/api/shared/{first.json()['token']}/docs").status_code == 200
    replaced = owner.post(f"/api/maps/{map_id}/shares", json={"replace": True})
    assert replaced.status_code == 201 and replaced.json()["token"] != first.json()["token"]
    assert reader.get(f"/api/shared/{first.json()['token']}/docs").status_code == 404
    assert count_rows(pool, "share_links", "map_id = %s", (map_id,)) == 1


def test_two_posts_without_replace_at_the_same_moment_give_one_link(quick_user, make_client, sample_file, pool, database):
    """Two requests for the link of a map without one, at the same moment: the first makes it (201), the second waits
    for the row lock on the map and gets the same link (200)."""
    anna = quick_user()
    map_id = anna.post("/api/maps/import", json=sample_file).json()["id"]
    twin = make_client(cookies={"__Host-session": anna.cookies.get("__Host-session")})
    with psycopg.connect(database) as hold:
        hold.execute("SELECT id FROM maps WHERE id = %s FOR UPDATE", (map_id,))
        calls = [Background(lambda c=c: c.post(f"/api/maps/{map_id}/shares")) for c in (anna, twin)]
        wait_for_locks(pool, 2)
        hold.rollback()
    answers = [call.result() for call in calls]
    assert sorted(a.status_code for a in answers) == [200, 201]
    assert answers[0].json()["token"] == answers[1].json()["token"]
    assert count_rows(pool, "share_links", "map_id = %s", (map_id,)) == 1


def test_public_map_by_path(owner, filled_map, make_client):
    handle, slug = owner.account["handle"], filled_map["slug"]
    reader = make_client()
    assert reader.get(f"/{handle}/{slug}").status_code == 404
    assert reader.get(f"/api/public/{handle}/{slug}/docs").status_code == 404
    assert reader.get(f"/api/public/{handle}").status_code == 404
    published = owner.patch(f"/api/maps/{filled_map['id']}", json={"visibility": "public"}).json()
    assert published["subdomainUrl"] == f"https://{handle}.it-skills.test/{slug}"

    page = reader.get(f"/{handle}/{slug}")
    assert page.status_code == 200 and "Testseite der Karte" in page.text
    assert re.search(r'<head><base href="/"><script type="application/json" id="it-skills-server">', page.text.replace("\n", ""))
    config = server_config(page.text)
    assert config == {"mode": "public", "api": f"/api/public/{handle}/{slug}", "canWrite": False,
                      "map": {"title": filled_map["title"], "slug": slug, "owner": handle, "visibility": "public"},
                      "account": f"{BASE}/account", "language": None}
    docs = reader.get(config["api"] + "/docs").json()
    assert docs["canWrite"] is False and len(docs["docs"]) > 0
    assert reader.get(config["api"] + "/access").json() == {"canWrite": False}
    assert reader.get(f"/api/public/{handle}/{slug}").json()["title"] == filled_map["title"]
    listing = reader.get(f"/api/public/{handle}").json()
    assert [m["slug"] for m in listing["maps"]] == [slug]
    user_page = reader.get(f"/{handle}")
    assert user_page.status_code == 200 and f'href="/{handle}/{slug}"' in user_page.text
    assert reader.get("/nobody-here").status_code == 404
    assert reader.get(f"/{handle}/missing").status_code == 404


def test_public_map_by_host_header(owner, filled_map, make_client):
    handle, slug = owner.account["handle"], filled_map["slug"]
    reader = make_client()
    host = {"Host": f"{handle}.it-skills.test"}
    assert reader.get(f"/{slug}", headers=host).status_code == 404
    owner.patch(f"/api/maps/{filled_map['id']}", json={"visibility": "public"})
    page = reader.get(f"/{slug}", headers=host)
    assert page.status_code == 200 and server_config(page.text)["api"] == f"/api/public/{handle}/{slug}"
    port_host = {"Host": f"{handle}.it-skills.test:8443"}
    assert reader.get(f"/{slug}", headers=port_host).status_code == 200
    listing = reader.get("/", headers=host)
    assert listing.status_code == 200 and f'href="/{slug}"' in listing.text
    assert reader.get(f"/api/public/{handle}/{slug}/docs", headers=host).status_code == 200
    # The main domain, www and unknown handles are no user sites. www sends the browser to the main domain.
    assert reader.get(f"/{slug}").status_code == 404
    www = reader.get(f"/{slug}", headers={"Host": "www.it-skills.test"}, follow_redirects=False)
    assert www.status_code == 308 and www.headers["location"] == f"{BASE}/{slug}"
    assert reader.get(f"/{slug}", headers={"Host": "nobody-here.it-skills.test"}).status_code == 404
    assert reader.get(f"/{slug}", headers={"Host": f"{handle}.other.example"}).status_code == 404
    assert reader.get("/", headers={"Host": "nobody-here.it-skills.test"}).status_code == 404
    konto = reader.get("/account", headers=host, follow_redirects=False)
    assert konto.status_code == 302 and konto.headers["location"] == f"{BASE}/account"
    owner.patch(f"/api/maps/{filled_map['id']}", json={"visibility": "link"})
    assert reader.get(f"/{slug}", headers=host).status_code == 404


def test_a_subdomain_serves_only_the_maps_of_its_owner(quick_user, make_client, sample_file):
    """The subdomain of Alice is her site. A page or an API path there that names a map of another owner is a 404, so
    that nobody shows his map under the address of somebody else. The main domain serves every map."""
    alice, mallory = quick_user(), quick_user()
    own = alice.post("/api/maps/import", json=sample_file).json()
    alice.patch(f"/api/maps/{own['id']}", json={"visibility": "public"})
    own_token = alice.post(f"/api/maps/{own['id']}/shares").json()["token"]
    other = mallory.post("/api/maps/import", json={**sample_file, "title": "Echte Skills"}).json()
    mallory.patch(f"/api/maps/{other['id']}", json={"visibility": "public"})
    token = mallory.post(f"/api/maps/{other['id']}/shares").json()["token"]
    reader = make_client()
    host = {"Host": f"{alice.handle}.it-skills.test"}
    for path in (f"/{own['slug']}", "/", f"/{alice.handle}/{own['slug']}", f"/s/{own_token}",
                 f"/api/public/{alice.handle}", f"/api/public/{alice.handle}/{own['slug']}/docs",
                 f"/api/shared/{own_token}/docs", f"/api/maps/{own['id']}", f"/api/maps/{own['id']}/docs"):
        assert reader.get(path, headers=host).status_code == 200, path
    foreign = (f"/{mallory.handle}", f"/{mallory.handle}/{other['slug']}", f"/s/{token}",
               f"/api/public/{mallory.handle}", f"/api/public/{mallory.handle}/{other['slug']}",
               f"/api/public/{mallory.handle}/{other['slug']}/docs", f"/api/public/{mallory.handle}/{other['slug']}/access",
               f"/api/shared/{token}", f"/api/shared/{token}/docs", f"/api/shared/{token}/access",
               f"/api/maps/{other['id']}", f"/api/maps/{other['id']}/docs", f"/api/maps/{other['id']}/access")
    for path in foreign:
        response = reader.get(path, headers=host)
        assert response.status_code == 404 and "Echte Skills" not in response.text, path
        assert reader.get(path).status_code == 200, path


def test_owner_gets_the_write_config(owner, filled_map, make_client):
    handle, slug = owner.account["handle"], filled_map["slug"]
    page = owner.get(f"/{handle}/{slug}")
    assert page.status_code == 200
    config = server_config(page.text)
    assert config["mode"] == "owner" and config["canWrite"] is True and config["api"] == f"/api/maps/{filled_map['id']}"
    assert owner.get(config["api"] + "/access").json() == {"canWrite": True, "role": "owner"}
    assert config["role"] == "owner"
    assert page.headers["cache-control"] == "no-store"
    assert page.headers["x-frame-options"] == "SAMEORIGIN"
    assert page.headers["content-security-policy"] == site_policy("'self'")


def test_page_config_is_escaped(owner):
    created = owner.post("/api/maps", json={"title": "</script><script>alert(1)</script>"}).json()
    page = owner.get(created["pageUrl"].replace(BASE, "")).text
    assert "<script>alert(1)" not in page
    assert server_config(page)["map"]["title"] == "</script><script>alert(1)</script>"


def test_fallback_page_without_page_file(make_app, make_client, signup):
    client = make_client(make_app(page_file="/nowhere/index.html"))
    signup(client)
    created = client.post("/api/maps", json={"title": "Ohne Seite"}).json()
    page = client.get(created["pageUrl"].replace(BASE, ""))
    assert page.status_code == 200 and "PAGE_FILE" in page.text
    assert server_config(page.text)["mode"] == "owner"


def test_account_page(client):
    page = client.get("/account")
    assert page.status_code == 200 and "Register" in page.text
    assert "frame-ancestors 'none'" in page.headers["content-security-policy"]
    assert client.get("/account/account.js").headers["content-type"].startswith("text/javascript")
    assert client.get("/account/other.js").status_code == 404


def test_start_page_names_the_account(client, signup, make_app, make_client):
    page = client.get("/", follow_redirects=False)
    assert page.status_code == 200 and "Testseite des Starts" in page.text
    assert page.headers["cache-control"] == "no-store" and page.headers["x-frame-options"] == "SAMEORIGIN"
    assert server_config(page.text) == {"mode": "site", "account": f"{BASE}/account", "user": None, "language": None}
    account = signup(client)
    for path in ("/", "/index.html"):
        assert server_config(client.get(path).text) == {"mode": "site", "account": f"{BASE}/account",
                                                        "user": {"handle": account["handle"]}, "language": "en"}
    # A subdomain has no start page, and without START_FILE the main domain sends the account page.
    assert client.get("/index.html", headers={"Host": f"{account['handle']}.it-skills.test"}).status_code == 404
    bare = make_client(make_app(start_file="/nowhere/index.html"))
    assert bare.get("/", follow_redirects=False).headers["location"] == "/account"


def test_unknown_routes(client):
    response = client.get("/api/nothing")
    assert response.status_code == 404 and response.json()["error"] == "not_found"
    response = client.get("/a/b/c")
    assert response.status_code == 404 and response.headers["content-type"].startswith("text/html")
    assert client.delete("/api/account").status_code == 405
