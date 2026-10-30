"""Maps and their documents: create, list, rename, delete, versions, polling, limits, ids, CSRF, files."""
from __future__ import annotations

import json

import psycopg
import pytest
from conftest import BASE, Background, count_rows, unique, wait_for_locks

from app.migrate import migrate
from app.store import MAX_DOCUMENT


@pytest.fixture
def owner(client, signup):
    signup(client)
    return client


def new_map(client, title="Meine Karte", **fields):
    response = client.post("/api/maps", json={"title": title, **fields})
    assert response.status_code == 201, response.text
    return response.json()


def put(client, map_id, collection, doc_id, data):
    return client.put(f"/api/maps/{map_id}/docs/{collection}/{doc_id}", json=data)


def test_create_list_rename_delete(owner, pool):
    first = new_map(owner, "Meine Kenntnisse")
    assert first["slug"] == "meine-kenntnisse" and first["visibility"] == "private" and first["version"] == 1
    assert first["size"] == 0 and first["pageUrl"] == f"{BASE}/{first['owner']}/meine-kenntnisse"
    second = new_map(owner, "Zweite Karte")
    listed = owner.get("/api/maps").json()["maps"]
    assert {m["id"] for m in listed} == {first["id"], second["id"]}
    renamed = owner.patch(f"/api/maps/{first['id']}", json={"title": "Neuer Titel"}).json()
    assert renamed["title"] == "Neuer Titel" and renamed["slug"] == "meine-kenntnisse" and renamed["version"] == 2
    moved = owner.patch(f"/api/maps/{first['id']}", json={"slug": "skills"}).json()
    assert moved["slug"] == "skills"
    assert owner.get(f"/api/maps/{first['id']}").json()["title"] == "Neuer Titel"
    assert owner.delete(f"/api/maps/{first['id']}").status_code == 204
    assert owner.get(f"/api/maps/{first['id']}").status_code == 404
    assert [m["id"] for m in owner.get("/api/maps").json()["maps"]] == [second["id"]]
    assert count_rows(pool, "maps") == 1


def test_slugs(owner):
    assert new_map(owner, "Fähigkeiten & Größe")["slug"] == "faehigkeiten-groesse"
    assert new_map(owner, "Fähigkeiten & Größe")["slug"] == "faehigkeiten-groesse-2"
    assert new_map(owner, "Fähigkeiten & Größe")["slug"] == "faehigkeiten-groesse-3"
    assert new_map(owner, "API")["slug"] == "api-map"
    assert new_map(owner, "!!!")["slug"] == "map"
    response = owner.post("/api/maps", json={"title": "x", "slug": "faehigkeiten-groesse"})
    assert response.status_code == 409 and response.json()["error"] == "slug_taken"
    for slug in ("Gross", "-a", "a-", "a--b", "api", "konto", "a" * 61, "ä"):
        response = owner.post("/api/maps", json={"title": "x", "slug": slug})
        assert response.status_code == 400 and response.json()["error"] == "invalid_slug", slug
    for title in ("", "   ", "x" * 201):
        response = owner.post("/api/maps", json={"title": title})
        assert response.status_code in (400, 422), title


def _while_another_writes(pool, database, owner_id, slug, call):
    """Runs call while another transaction writes a map with this slug: the other transaction inserts its map first and
    commits only once the call waits for the row, as when two requests pick one slug at the same moment."""
    with psycopg.connect(database) as other:
        other.execute("INSERT INTO maps (owner_id, title, slug) VALUES (%s, 'Andere', %s)", (owner_id, slug))
        running = Background(call)
        wait_for_locks(pool, 1)
        other.commit()
    return running.result()


def test_a_slug_that_another_request_takes_at_the_same_moment(quick_user, pool, database, sample_file):
    """Two requests that want one slug: a slug that the request names gets 409 slug_taken, and a slug that the server
    picks becomes the next free one. That holds for a new map, an import, a change of the slug and a move into a team."""
    anna = quick_user()
    response = _while_another_writes(pool, database, anna.user_id, "same-slug",
                                     lambda: anna.post("/api/maps", json={"title": "X", "slug": "same-slug"}))
    assert response.status_code == 409 and response.json()["error"] == "slug_taken"
    response = _while_another_writes(pool, database, anna.user_id, "gleicher-titel",
                                     lambda: anna.post("/api/maps", json={"title": "Gleicher Titel"}))
    assert response.status_code == 201 and response.json()["slug"] == "gleicher-titel-2"
    file = {**sample_file, "title": "Gleicher Titel"}
    response = _while_another_writes(pool, database, anna.user_id, "gleicher-titel-3",
                                     lambda: anna.post("/api/maps/import", json=file))
    assert response.status_code == 201 and response.json()["slug"] == "gleicher-titel-4"
    assert len(anna.get(f"/api/maps/{response.json()['id']}/docs").json()["docs"]) > 0
    own = new_map(anna, "Eigene")
    response = _while_another_writes(pool, database, anna.user_id, "neu",
                                     lambda: anna.patch(f"/api/maps/{own['id']}", json={"slug": "neu"}))
    assert response.status_code == 409 and response.json()["error"] == "slug_taken"
    team = anna.post("/api/teams", json={"name": "Team", "handle": unique("t")}).json()
    with pool.connection() as conn:
        team_id = conn.execute("SELECT id FROM owners WHERE handle = %s", (team["handle"],)).fetchone()["id"]
    response = _while_another_writes(pool, database, team_id, "eigene",
                                     lambda: anna.post(f"/api/maps/{own['id']}/move", json={"team": team["handle"]}))
    assert response.status_code == 200 and response.json()["slug"] == "eigene-2" and response.json()["owner"] == team["handle"]


def test_max_maps(make_app, make_client, signup):
    client = make_client(make_app(max_maps=2))
    signup(client)
    new_map(client, "Eins")
    new_map(client, "Zwei")
    response = client.post("/api/maps", json={"title": "Drei"})
    assert response.status_code == 409 and response.json()["error"] == "too_many_maps"


def test_documents_set_and_delete(owner):
    map_id = new_map(owner)["id"]
    skill = {"name": "Python", "group": "sd-lang", "rating": 2, "places": ["SIDE"], "order": 1}
    response = put(owner, map_id, "skills", "python", skill)
    assert response.status_code == 200 and response.json() == {"version": 2}
    assert put(owner, map_id, "groups", "sd-lang", {"name": "Sprachen", "area": "sd"}).json() == {"version": 3}
    changed = {**skill, "rating": 3}
    assert put(owner, map_id, "skills", "python", changed).json() == {"version": 4}
    body = owner.get(f"/api/maps/{map_id}/docs").json()
    assert body["version"] == 4 and body["full"] is True and body["canWrite"] is True
    assert body["docs"] == [
        {"collection": "groups", "id": "sd-lang", "data": {"name": "Sprachen", "area": "sd"}},
        {"collection": "skills", "id": "python", "data": changed},
    ]
    assert owner.delete(f"/api/maps/{map_id}/docs/skills/python").json() == {"version": 5}
    # Deleting a missing document changes nothing.
    assert owner.delete(f"/api/maps/{map_id}/docs/skills/python").json() == {"version": 5}
    body = owner.get(f"/api/maps/{map_id}/docs").json()
    assert [d["id"] for d in body["docs"]] == ["sd-lang"] and body["deleted"] == []
    size = len(json.dumps({"name": "Sprachen", "area": "sd"}, separators=(",", ":")))
    assert owner.get(f"/api/maps/{map_id}").json()["size"] == size


def test_document_ids_with_special_characters(owner):
    map_id = new_map(owner)["id"]
    for doc_id in ("C#", "ASP.NET Core", "Ä ö ü", "a" * 200, "x?y=1&z"):
        response = owner.put(f"/api/maps/{map_id}/docs/skills/" + _quote(doc_id), json={"name": doc_id})
        assert response.status_code == 200, doc_id
    ids = {d["id"] for d in owner.get(f"/api/maps/{map_id}/docs").json()["docs"]}
    assert ids == {"C#", "ASP.NET Core", "Ä ö ü", "a" * 200, "x?y=1&z"}


def _quote(text: str) -> str:
    from urllib.parse import quote
    return quote(text, safe="")


def test_polling_with_since(owner):
    map_id = new_map(owner)["id"]
    put(owner, map_id, "skills", "a", {"name": "A"})
    version = owner.get(f"/api/maps/{map_id}/docs").json()["version"]
    assert version == 2
    response = owner.get(f"/api/maps/{map_id}/docs", params={"since": version})
    assert response.status_code == 304 and response.content == b""
    put(owner, map_id, "skills", "b", {"name": "B"})
    delta = owner.get(f"/api/maps/{map_id}/docs", params={"since": version}).json()
    assert delta["version"] == 3 and delta["full"] is False
    assert delta["docs"] == [{"collection": "skills", "id": "b", "data": {"name": "B"}}] and delta["deleted"] == []
    owner.delete(f"/api/maps/{map_id}/docs/skills/a")
    delta = owner.get(f"/api/maps/{map_id}/docs", params={"since": 3}).json()
    assert delta["version"] == 4 and delta["docs"] == [] and delta["deleted"] == [{"collection": "skills", "id": "a"}]
    # A rename is a write too, so the page sees it.
    owner.patch(f"/api/maps/{map_id}", json={"title": "Umbenannt"})
    assert owner.get(f"/api/maps/{map_id}/docs", params={"since": 4}).json()["version"] == 5
    # A version from the future gets everything.
    future = owner.get(f"/api/maps/{map_id}/docs", params={"since": 99}).json()
    assert future["full"] is True and [d["id"] for d in future["docs"]] == ["b"]
    assert owner.get(f"/api/maps/{map_id}/docs", params={"since": -1}).status_code == 422


def test_write_conflict_with_base(owner):
    """A write with ?base= is refused when the document changed after that version (two tabs, one document)."""
    map_id = new_map(owner)["id"]
    path = f"/api/maps/{map_id}/docs/areas/sd"
    assert owner.put(path, params={"base": 1}, json={"name": "A"}).json() == {"version": 2}
    # Tab 1 knows the document from version 2 and writes; tab 2 still knows only version 1.
    assert owner.put(path, params={"base": 2}, json={"name": "B"}).json() == {"version": 3}
    response = owner.put(path, params={"base": 1}, json={"name": "C"})
    assert response.status_code == 409 and response.json()["error"] == "conflict"
    assert owner.get(f"/api/maps/{map_id}/docs").json()["docs"][0]["data"] == {"name": "B"}
    assert owner.get(f"/api/maps/{map_id}").json()["version"] == 3
    response = owner.delete(path, params={"base": 2})
    assert response.status_code == 409 and response.json()["error"] == "conflict"
    # The version of the own last write is enough; a write without base never conflicts.
    assert owner.put(path, params={"base": 3}, json={"name": "D"}).json() == {"version": 4}
    assert owner.put(path, json={"name": "E"}).json() == {"version": 5}
    # A new document conflicts with one that somebody else created after base.
    assert owner.put(f"/api/maps/{map_id}/docs/areas/new", params={"base": 5}, json={"name": "N"}).status_code == 200
    assert owner.put(f"/api/maps/{map_id}/docs/areas/new", params={"base": 5}, json={"name": "M"}).status_code == 409
    # Deleting a document that is deleted already is no conflict, writing over a newer delete is one.
    assert owner.delete(path, params={"base": 5}).json() == {"version": 7}
    assert owner.delete(path, params={"base": 2}).json() == {"version": 7}
    assert owner.put(path, params={"base": 5}, json={"name": "F"}).status_code == 409
    assert owner.put(path, params={"base": -1}, json={"name": "F"}).status_code == 422


def test_document_size_limit(owner):
    map_id = new_map(owner)["id"]
    assert put(owner, map_id, "notes", "big", {"text": "x" * (MAX_DOCUMENT - 20)}).status_code == 200
    response = put(owner, map_id, "notes", "too-big", {"text": "x" * (MAX_DOCUMENT + 1)})
    assert response.status_code == 413 and response.json()["error"] == "document_too_large"
    response = owner.put(f"/api/maps/{map_id}/docs/notes/huge", content=b'{"t":"' + b"x" * (2 * MAX_DOCUMENT) + b'"}',
                         headers={"Content-Type": "application/json"})
    assert response.status_code == 413 and response.json()["error"] == "body_too_large"
    assert [d["id"] for d in owner.get(f"/api/maps/{map_id}/docs").json()["docs"]] == ["big"]


def test_map_size_limit(owner):
    map_id = new_map(owner)["id"]
    chunk = "x" * 250_000
    for n in range(16):
        assert put(owner, map_id, "notes", f"n{n}", {"text": chunk}).status_code == 200
    before = owner.get(f"/api/maps/{map_id}").json()
    response = put(owner, map_id, "notes", "n16", {"text": chunk})
    assert response.status_code == 413 and response.json()["error"] == "map_too_large"
    after = owner.get(f"/api/maps/{map_id}").json()
    assert after["version"] == before["version"] and after["size"] == before["size"]
    # Making a document smaller still works, and so does a new document after a delete.
    assert put(owner, map_id, "notes", "n0", {"text": "klein"}).status_code == 200
    assert put(owner, map_id, "notes", "n16", {"text": chunk}).status_code == 200


def test_bad_ids_and_bad_documents(owner):
    map_id = new_map(owner)["id"]
    for collection in ("Skills", "1skills", "sk ills", "s" * 42, "skills.x", "_x"):
        response = put(owner, map_id, _quote(collection), "a", {"name": "A"})
        assert response.status_code == 400 and response.json()["error"] == "invalid_collection", collection
    assert put(owner, map_id, "s" * 41, "a", {"name": "A"}).status_code == 200
    response = put(owner, map_id, "skills", "a" * 201, {"name": "A"})
    assert response.status_code == 400 and response.json()["error"] == "invalid_id"
    response = put(owner, map_id, "skills", _quote("a\tb"), {"name": "A"})
    assert response.status_code == 400 and response.json()["error"] == "invalid_id"
    # A slash, even encoded, never reaches a document id.
    assert put(owner, map_id, "skills", "a%2Fb", {"name": "A"}).status_code in (400, 404)
    for data in ([1, 2], "text", 42, None):
        response = put(owner, map_id, "skills", "a", data)
        assert response.status_code in (400, 422), data
    response = owner.put(f"/api/maps/{map_id}/docs/skills/a", content=b'{"x": NaN}',
                         headers={"Content-Type": "application/json"})
    assert response.status_code in (400, 422)
    response = put(owner, map_id, "skills", "a", {"text": "null\u0000char"})
    assert response.status_code == 400 and response.json()["error"] == "invalid_document"
    assert owner.get("/api/maps/not-a-uuid").status_code == 404
    assert owner.get("/api/maps/00000000-0000-4000-8000-000000000000/docs").status_code == 404


def test_lone_surrogates_are_refused(owner):
    """JSON can name one half of a UTF-16 pair, such as \\ud83d, that no UTF-8 text holds. A document, a map file and a
    title with one are refused as invalid, in a value and in a key, and nothing is stored."""
    map_id = new_map(owner)["id"]
    raw = {"Content-Type": "application/json"}
    for body in (r'{"name": "abc\ud83d"}', r'{"a\udc00": 1}', r'{"list": [{"deep": "x\udfffy"}]}'):
        response = owner.put(f"/api/maps/{map_id}/docs/skills/x", content=body.encode(), headers=raw)
        assert response.status_code == 400 and response.json()["error"] == "invalid_document", body
    head = '{"format": "it-skills-map", "schema": 1, '
    for body, code in ((r'"title": "t", "collections": {"skills": {"a": {"n": "\udc00"}}}}', "invalid_document"),
                       (r'"title": "t", "collections": {"skills": {"a": {"\ud800": 1}}}}', "invalid_document"),
                       (r'"title": "t", "collections": {"skills": {"a\ud800": {}}}}', "invalid_id"),
                       (r'"title": "t\ud800", "collections": {}}', "invalid_title")):
        response = owner.post("/api/maps/import", content=(head + body).encode(), headers=raw)
        assert response.status_code == 400 and response.json()["error"] == code, body
    # A request with fixed fields, such as a new map, fails already in the check of its fields.
    response = owner.post("/api/maps", content=r'{"title": "Karte \udbff"}'.encode(), headers=raw)
    assert response.status_code == 422 and response.json()["error"] == "invalid_request"
    assert [m["id"] for m in owner.get("/api/maps").json()["maps"]] == [map_id]
    assert owner.get(f"/api/maps/{map_id}/docs").json()["docs"] == []


def test_other_users_see_nothing(owner, make_client, signup):
    map_id = new_map(owner)["id"]
    put(owner, map_id, "skills", "a", {"name": "A"})
    stranger = make_client()
    signup(stranger)
    anonymous = make_client()
    for client in (stranger, anonymous):
        assert client.get(f"/api/maps/{map_id}").status_code == 404
        assert client.get(f"/api/maps/{map_id}/docs").status_code == 404
        assert client.get(f"/api/maps/{map_id}/access").status_code == 404
        assert put(client, map_id, "skills", "b", {"name": "B"}).status_code in (401, 404)
        assert client.delete(f"/api/maps/{map_id}").status_code in (401, 404)
        assert client.patch(f"/api/maps/{map_id}", json={"title": "x"}).status_code in (401, 404)
        assert client.get(f"/api/maps/{map_id}/export").status_code in (401, 404)
    assert stranger.get("/api/maps").json()["maps"] == []
    assert anonymous.get("/api/maps").status_code == 401
    assert owner.get(f"/api/maps/{map_id}/docs").json()["version"] == 2


def test_access_endpoint(owner, make_client):
    map_id = new_map(owner)["id"]
    assert owner.get(f"/api/maps/{map_id}/access").json() == {"canWrite": True, "role": "owner"}
    reader = make_client()
    assert reader.get(f"/api/maps/{map_id}/access").status_code == 404
    owner.patch(f"/api/maps/{map_id}", json={"visibility": "public"})
    assert reader.get(f"/api/maps/{map_id}/access").json() == {"canWrite": False, "role": None}
    assert reader.get(f"/api/maps/{map_id}/docs").json()["canWrite"] is False
    assert put(reader, map_id, "skills", "a", {"name": "A"}).status_code == 401


def test_csrf(owner, make_client):
    raw = make_client(headers={})
    raw.cookies = owner.cookies
    cases = [
        {},
        {"Origin": BASE},
        {"X-Requested-With": "it-skills"},
        {"X-Requested-With": "it-skills", "Origin": "https://evil.example"},
        {"X-Requested-With": "XMLHttpRequest", "Origin": BASE},
        {"X-Requested-With": "it-skills", "Origin": "null"},
        {"X-Requested-With": "it-skills", "Origin": "http://it-skills.test"},
    ]
    for headers in cases:
        response = raw.post("/api/maps", json={"title": "x"}, headers=headers)
        assert response.status_code == 403 and response.json()["error"] == "csrf", headers
        assert raw.post("/api/auth/login", json={"email": "a@b.cd", "password": "x"}, headers=headers).status_code == 403
    assert raw.get("/api/maps").status_code == 200
    assert raw.post("/api/maps", json={"title": "x"}, headers={"X-Requested-With": "it-skills", "Origin": BASE}).status_code == 201
    assert owner.get("/api/maps").json()["maps"][0]["title"] == "x"


def test_export_and_import_round_trip(owner, sample_file):
    response = owner.post("/api/maps/import", json=sample_file)
    assert response.status_code == 201
    imported = response.json()
    assert imported["title"] == sample_file["title"] and imported["visibility"] == "private"
    assert imported["slug"] == "beispielkarte-fuer-tests" and imported["version"] == 1 and imported["size"] > 0
    docs = owner.get(f"/api/maps/{imported['id']}/docs").json()
    assert len(docs["docs"]) == sum(len(c) for c in sample_file["collections"].values())
    response = owner.get(f"/api/maps/{imported['id']}/export")
    assert response.status_code == 200
    assert 'filename="beispielkarte-fuer-tests.json"' in response.headers["content-disposition"]
    exported = response.json()
    assert exported["format"] == "it-skills-map" and exported["schema"] == 1
    assert exported["title"] == sample_file["title"] and exported["exportedAt"].endswith("Z")
    assert exported["collections"] == sample_file["collections"]
    again = owner.post("/api/maps/import", json=exported).json()
    assert again["slug"] == "beispielkarte-fuer-tests-2"
    assert owner.get(f"/api/maps/{again['id']}/export").json()["collections"] == sample_file["collections"]
    # The size of an imported map counts like the sizes of documents written one by one.
    put(owner, again["id"], "skills", "python", sample_file["collections"]["skills"]["python"])
    assert owner.get(f"/api/maps/{again['id']}").json()["size"] == imported["size"]


def test_import_rejects_bad_files(owner, sample_file):
    cases = [
        ({**sample_file, "format": "other"}, "wrong_format"),
        ({**sample_file, "schema": 2}, "unsupported_schema"),
        ({**sample_file, "schema": "1"}, "invalid_map_file"),
        ({**sample_file, "collections": []}, "invalid_map_file"),
        ({**sample_file, "collections": {"Bad": {}}}, "invalid_collection"),
        ({**sample_file, "collections": {"skills": {"a/b": {}}}}, "invalid_id"),
        ({**sample_file, "collections": {"skills": {"a": [1]}}}, "invalid_document"),
        ([1, 2, 3], "invalid_map_file"),
    ]
    for file, code in cases:
        response = owner.post("/api/maps/import", json=file)
        assert response.status_code in (400, 422) and response.json()["error"] == code, code
    big = {**sample_file, "collections": {"notes": {f"n{n}": {"t": "x" * 250_000} for n in range(17)}}}
    response = owner.post("/api/maps/import", json=big)
    assert response.status_code == 413 and response.json()["error"] == "map_too_large"
    assert owner.get("/api/maps").json()["maps"] == []
    untitled = {key: value for key, value in sample_file.items() if key != "title"}
    assert owner.post("/api/maps/import", json=untitled).json()["title"] == "Imported map"


# The rules of selfhost/FORMAT.md that the site applies too (finding B4 of the final review). Each id breaks a rule:
# (collection, id, the variant of invalid_id or None for the rule of every collection).
BAD_IDS = [
    ("areas", 'x"] .y', "areas"), ("areas", "Gross", "areas"), ("areas", "a" * 41, "areas"),
    ("stations", "PRIVAT", "stations"), ("stations", "Ai", "stations"), ("stations", "1A", "stations"),
    ("groups", "Gruppe", "groups"), ("groups", "-x", "groups"),
    ("skills", "__proto__", None), ("skills", "..", None), ("skills", ".", None), ("skills", "a\x01b", None),
    ("skills", "a\x7f", None), ("projects", "x\x1f", None),
]


def test_an_import_refuses_the_ids_that_the_site_refuses(owner, sample_file):
    """The import gave 201 for areas/x"] .y, stations/PRIVAT, skills/__proto__, skills/.. and skills/., and the page then
    hid the bad area without a message. Now the server refuses every id that the site refuses, with the same rules."""
    for collection, doc_id, variant in BAD_IDS:
        response = owner.post("/api/maps/import", json={**sample_file, "collections": {collection: {doc_id: {"name": "X"}}}})
        body = response.json()
        assert response.status_code == 400 and body["error"] == "invalid_id", (collection, doc_id, body)
        assert body["params"].get("variant") == variant, (collection, doc_id, body)
        if variant == "stations":
            assert body["params"]["code"] == "PRIVAT"
    assert owner.get("/api/maps").json()["maps"] == []
    # A collection name with a line break at the end matched the old pattern, whose "$" matches before a closing "\n".
    response = owner.post("/api/maps/import", json={**sample_file, "collections": {"skills\n": {}}})
    assert response.status_code == 400 and response.json()["error"] == "invalid_collection"


def test_a_write_refuses_the_ids_that_the_site_refuses(owner):
    map_id = new_map(owner)["id"]
    for collection, doc_id, variant in BAD_IDS:
        if doc_id in (".", ".."):
            continue
        for response in (put(owner, map_id, collection, _quote(doc_id), {"name": "X"}),
                         owner.delete(f"/api/maps/{map_id}/docs/{collection}/{_quote(doc_id)}")):
            body = response.json()
            assert response.status_code == 400 and body["error"] == "invalid_id", (collection, doc_id, body)
            assert body["params"].get("variant") == variant, (collection, doc_id, body)
    # "." and ".." never reach a route as a document id: a client removes them from the path, or the server refuses them.
    for doc_id in ("%2E", "%2E%2E"):
        response = put(owner, map_id, "skills", doc_id, {"name": "X"})
        assert response.status_code in (400, 404, 405), (doc_id, response.status_code)
    for collection, doc_id in (("areas", "sd"), ("areas", "a_b-1"), ("stations", "ACME"), ("stations", "A1"),
                               ("groups", "sd-lang"), ("groups", "1x"), ("skills", "C# und .NET"), ("skills", "..a"),
                               ("skills", "a" * 200)):
        assert put(owner, map_id, collection, _quote(doc_id), {"name": "X"}).status_code == 200, (collection, doc_id)
    assert put(owner, map_id, _quote("skills\n"), "a", {"name": "X"}).json()["error"] == "invalid_collection"
    response = owner.patch(f"/api/maps/{map_id}", json={"slug": "neu\n"})
    assert response.status_code == 400 and response.json()["error"] == "invalid_slug"


def test_a_title_follows_the_rule_of_the_site(owner, sample_file):
    """A title has 120 characters at most, as in selfhost/FORMAT.md and on the site. An import makes each run of white
    space one space and keeps the first 120 characters, as the site does. It counts characters, so a cut never splits a
    pair of UTF-16 halves. The API refuses a longer title."""
    def imported(title):
        return owner.post("/api/maps/import", json={**sample_file, "title": title})
    assert imported("Ä" * 130).json()["title"] == "Ä" * 120
    assert imported("a" + "\U0001F600" * 130).json()["title"] == "a" + "\U0001F600" * 119
    assert imported("  Meine \t\n Karte\u00a0 ").json()["title"] == "Meine Karte"
    assert imported("x" * 119 + " yz").json()["title"] == "x" * 119
    assert imported(" \t ").json()["title"] == "Imported map"
    for title in (5, None, ["Karte"], "Karte\x01", "Karte\x1c"):
        response = imported(title)
        assert response.status_code == 400 and response.json()["error"] == "invalid_title", title
        assert response.json()["params"] == {"max": 120}
    assert new_map(owner, "x" * 120)["title"] == "x" * 120
    for response in (owner.post("/api/maps", json={"title": "x" * 121}),
                     owner.patch(f"/api/maps/{new_map(owner)['id']}", json={"title": "y" * 121})):
        assert response.status_code == 400 and response.json() == {
            "error": "invalid_title", "message": "The title needs 1 to 120 characters, without control characters.",
            "params": {"max": 120}}


def test_schema_1_0_is_schema_1(owner, sample_file):
    """JavaScript reads 1.0 and 1 as the same number, so the site takes a file with "schema": 1.0. The server takes it
    too, and it refuses every schema that the site refuses (finding B7 of the final review)."""
    text = json.dumps({**sample_file, "schema": 1.0})
    assert '"schema": 1.0' in text
    response = owner.post("/api/maps/import", content=text.encode(), headers={"Content-Type": "application/json"})
    assert response.status_code == 201
    for schema, code in ((1.5, "invalid_map_file"), (True, "invalid_map_file"), (0.0, "invalid_map_file"),
                         (-1, "invalid_map_file"), (2.0, "unsupported_schema")):
        response = owner.post("/api/maps/import", json={**sample_file, "schema": schema})
        assert response.status_code == 422 and response.json()["error"] == code, schema


@pytest.mark.parametrize("reader", ["owner", "public", "shared"])
def test_the_version_and_the_documents_of_an_answer_come_from_one_moment(reader, quick_user, make_client, sample_file,
                                                                         pool, monkeypatch):
    """Finding B6 of the final review: each .../docs route read the map and then its documents, in two statements under
    READ COMMITTED. A write between the two gave the new documents with the old version, and the next edit of the reader
    got a false 409 conflict. The test commits a write at exactly that moment. The answer holds the state before it, and
    the next poll brings the write."""
    from app import access, store

    anna = quick_user()
    created = anna.post("/api/maps/import", json=sample_file).json()
    client, path = anna, f"/api/maps/{created['id']}/docs"
    if reader == "public":
        anna.patch(f"/api/maps/{created['id']}", json={"visibility": "public"})
        client, path = make_client(), f"/api/public/{anna.handle}/{created['slug']}/docs"
    elif reader == "shared":
        token = anna.post(f"/api/maps/{created['id']}/shares").json()["token"]
        client, path = make_client(), f"/api/shared/{token}/docs"
    read_documents, late = store.read_documents, {}

    def between(conn, map_row, since):
        # Another request writes the map and commits after the route read the map, before it reads the documents.
        if not late:
            with pool.connection() as other:
                row = access.find_map(other, created["id"], None, lock=True)
                late["version"] = store.put_document(other, row, "skills", "late", {"name": "Late"})["version"]
        return read_documents(conn, map_row, since)

    monkeypatch.setattr(store, "read_documents", between)
    answer = client.get(path).json()
    monkeypatch.undo()
    assert late, "the write between the two reads did not run"
    assert ("skills", "late") not in {(d["collection"], d["id"]) for d in answer["docs"]}
    assert answer["version"] == late["version"] - 1
    later = client.get(path, params={"since": answer["version"]}).json()
    assert later["version"] == late["version"] and [d["id"] for d in later["docs"]] == ["late"]


def test_migrations_are_recorded(database, pool):
    with pool.connection() as conn:
        versions = [row["version"] for row in conn.execute("SELECT version FROM schema_migrations ORDER BY version")]
    assert versions == ["0001_initial", "0002_embed", "0003_teams", "0004_language", "0005_freed_handles",
                        "0006_one_share_link", "0007_start_map"]
    assert migrate(database) == []


def test_no_dead_code_of_earlier_stages():
    """Four names had no caller left after stage c: a lock of a map, a copy of the settings and two aliases."""
    from app import access, accounts, config, store

    for owner, name in ((store, "lock_map"), (config.Settings, "with_changes"), (access, "public_map"),
                        (accounts, "_check_password")):
        assert not hasattr(owner, name), name


def test_health(client):
    assert client.get("/api/health").json() == {"status": "ok"}
