"""An existing database of stage b migrates to stage c without loss.

The test builds a database with the migrations of stage b (0001_initial and 0002_embed) and fills it with
stage b data, as the app of stage b writes it. Then it runs the migration of stage c (0003_teams) and the language
of the accounts (0004_language) and the one read link per map (0006_one_share_link), compares every old table row by
row, and uses the app on the migrated database: login, own maps, documents, polling, share links, public pages, the
embed view and a new team.

A second fixture starts one step earlier: a database with 0001_initial only, filled as the app of stage b wrote
it before the embed view existed. It runs 0002_embed, 0003_teams, 0004_language and 0006_one_share_link, proves that
every old row stays and that each old map gets the embed defaults, and uses the app on it in the same way.

A third fixture starts at stage c: a database with 0001 to 0003, filled with stage b data and with a team, its
members and an open invitation. It runs 0004_language, 0005_freed_handles and 0006_one_share_link, proves that every
row stays and that every account gets English, and uses the app on it: the language in the answers, a change of the
language, and the mails in the language of their recipient.

0006_one_share_link deletes every share link of the time before it, because the server kept only the hash of a token
then, and a link without its token cannot be shown to its owner again. So the share link of each fixture is gone, and
a new link works. A fourth fixture tests that migration on a database with several old links.

Each fixture also runs 0005_freed_handles. It only adds the empty table of the freed handles, so every old row stays.
Each fixture also runs 0007_start_map. It adds the start map of each owner, empty for every old owner, so every other
column of the owners stays."""
from __future__ import annotations

import os

import re

import psycopg
import pytest
from conftest import BASE, HEADERS, PASSWORD, TEST_DATABASE, make_settings, unique
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool
from starlette.testclient import TestClient

from app.main import create_app
from app.migrate import MIGRATIONS, migrate
from app.pages import site_policy
from app.security import hash_password, hash_token

UPGRADE_DATABASE = os.environ.get("UPGRADE_DATABASE", TEST_DATABASE + "_upgrade")
OLD_TABLES = ("owners", "users", "email_tokens", "sessions", "maps", "documents", "share_links", "rate_limits")
SHARE_TOKEN = "stage-b-share-token-0123456789abcdef"
SESSION_TOKEN = "stage-b-session-token-0123456789abcdef"
# The table whose rows 0006_one_share_link deletes: no share link of the time before it has a stored token.
DELETED_BY_0006 = ("share_links",)


def _recreate(name: str) -> None:
    with psycopg.connect("dbname=postgres", autocommit=True) as conn:
        conn.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name)))
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))


def _fill_stage_b(conn, embed: bool = True) -> dict:
    """Two users, three maps with documents (one deleted), a share link, a session, a token, a rate limit.
    embed=False leaves out the embed setting of the public map, for a database without 0002_embed."""
    password_hash = hash_password(PASSWORD)
    ids = {}
    for handle in ("anna-b", "bert-b"):
        ids[handle] = conn.execute("INSERT INTO owners (kind, handle) VALUES ('user', %s) RETURNING id",
                                   (handle,)).fetchone()["id"]
        conn.execute("INSERT INTO users (id, email, password_hash, confirmed_at) VALUES (%s, %s, %s, now())",
                     (ids[handle], f"{handle}@example.org", password_hash))
    anna = ids["anna-b"]
    maps = {}
    for slug, visibility in (("privat", "private"), ("geteilt", "link"), ("offen", "public")):
        maps[slug] = conn.execute(
            "INSERT INTO maps (owner_id, created_by, title, slug, visibility, version, size_bytes)"
            " VALUES (%s, %s, %s, %s, %s, 3, 17) RETURNING id",
            (anna, anna, f"Map {slug}", slug, visibility),
        ).fetchone()["id"]
        conn.execute("INSERT INTO documents (map_id, collection, doc_id, data, size_bytes, version)"
                     " VALUES (%s, 'skills', 'python', %s, 17, 2)", (maps[slug], Jsonb({"name": "Python"})))
        conn.execute("INSERT INTO documents (map_id, collection, doc_id, data, size_bytes, version)"
                     " VALUES (%s, 'skills', 'cobol', NULL, 0, 3)", (maps[slug],))
    if embed:
        conn.execute("UPDATE maps SET embed_allow = 'origins', embed_origins = %s WHERE id = %s",
                     (["https://cv.example.org"], maps["offen"]))
    conn.execute("INSERT INTO share_links (map_id, token_hash, created_by) VALUES (%s, %s, %s)",
                 (maps["geteilt"], hash_token(SHARE_TOKEN), anna))
    conn.execute("INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (%s, %s, now() + interval '1 day')",
                 (hash_token(SESSION_TOKEN), ids["bert-b"]))
    conn.execute("INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at)"
                 " VALUES (%s, %s, 'reset', now() + interval '1 hour')", (hash_token("reset-token"), anna))
    conn.execute("INSERT INTO rate_limits (bucket, key, window_start, hits) VALUES ('login_ip', 'k', now(), 2)")
    return {"maps": maps}


def _snapshot(conn) -> dict:
    """Every row of every old table, in a fixed order."""
    return {table: sorted(conn.execute(f"SELECT * FROM {table}").fetchall(), key=lambda row: repr(sorted(row.items())))
            for table in OLD_TABLES}


@pytest.fixture
def upgraded():
    _recreate(UPGRADE_DATABASE)
    conninfo = f"dbname={UPGRADE_DATABASE}"
    assert migrate(conninfo, until="0002_embed") == ["0001_initial", "0002_embed"]
    with psycopg.connect(conninfo, row_factory=dict_row) as conn:
        data = _fill_stage_b(conn)
        before = _snapshot(conn)
    assert migrate(conninfo) == ["0003_teams", "0004_language", "0005_freed_handles", "0006_one_share_link",
                                 "0007_start_map"]
    with psycopg.connect(conninfo, row_factory=dict_row) as conn:
        after = _snapshot(conn)
    pool = ConnectionPool(conninfo, min_size=1, max_size=4, kwargs={"row_factory": dict_row}, open=True)
    try:
        yield {"before": before, "after": after, "pool": pool, "conninfo": conninfo, **data}
    finally:
        pool.close()
        with psycopg.connect("dbname=postgres", autocommit=True) as conn:
            conn.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(UPGRADE_DATABASE)))


def test_stage_b_rows_stay_as_they_are(upgraded):
    for table in OLD_TABLES:
        if table == "users":
            # 0004_language adds the language, and every old account gets English.
            assert _without(upgraded["after"]["users"], LANGUAGE) == _without(upgraded["before"]["users"], ())
            assert all(row["language"] == "en" for row in upgraded["after"]["users"])
        elif table in DELETED_BY_0006:
            assert len(upgraded["before"][table]) == 1 and upgraded["after"][table] == [], table
        elif table == "owners":
            assert _owners_stay(upgraded["before"]["owners"], upgraded["after"]["owners"])
        else:
            assert upgraded["after"][table] == upgraded["before"][table], table
    assert migrate(upgraded["conninfo"]) == []


def test_stage_b_data_works_after_the_migration(upgraded):
    app = create_app(make_settings(upgraded["conninfo"]), pool=upgraded["pool"])
    anna = TestClient(app, base_url=BASE, headers=HEADERS)
    response = anna.post("/api/auth/login", json={"email": "anna-b@example.org", "password": PASSWORD})
    assert response.status_code == 200 and response.json()["handle"] == "anna-b"
    maps = {m["slug"]: m for m in anna.get("/api/maps").json()["maps"]}
    assert set(maps) == {"privat", "geteilt", "offen"}
    assert maps["geteilt"]["shares"] == 0 and maps["offen"]["ownerType"] == "user" and maps["offen"]["role"] == "owner"
    map_id = str(upgraded["maps"]["privat"])
    docs = anna.get(f"/api/maps/{map_id}/docs").json()
    assert docs["version"] == 3 and docs["docs"] == [{"collection": "skills", "id": "python",
                                                      "data": {"name": "Python"}}]
    delta = anna.get(f"/api/maps/{map_id}/docs", params={"since": 2}).json()
    assert delta["deleted"] == [{"collection": "skills", "id": "cobol"}]
    assert anna.get(f"/api/maps/{map_id}/access").json() == {"canWrite": True, "role": "owner"}
    assert anna.put(f"/api/maps/{map_id}/docs/skills/rust", json={"name": "Rust"}).json() == {"version": 4}

    # The session of stage b still signs in, and the public map still works. The share link of stage b is gone
    # (0006_one_share_link), and a new link of the owner works.
    bert = TestClient(app, base_url=BASE, headers=HEADERS, cookies={"__Host-session": SESSION_TOKEN})
    assert bert.get("/api/account").json()["handle"] == "bert-b"
    visitor = TestClient(app, base_url=BASE, headers=HEADERS)
    assert visitor.get(f"/api/shared/{SHARE_TOKEN}/docs").status_code == 404
    token = anna.post(f"/api/maps/{upgraded['maps']['geteilt']}/shares").json()["token"]
    assert visitor.get(f"/api/shared/{token}/docs").json()["docs"][0]["id"] == "python"
    assert visitor.get("/anna-b/offen").status_code == 200
    assert visitor.get("/anna-b/privat").status_code == 404
    assert visitor.get("/api/public/anna-b").json()["maps"][0]["slug"] == "offen"
    embed = visitor.get("/e/anna-b/offen")
    assert embed.status_code == 200
    assert embed.headers["content-security-policy"] == site_policy("'self' https://cv.example.org")
    assert maps["offen"]["embed"]["allow"] == "origins" and maps["offen"]["embed"]["origins"] == ["https://cv.example.org"]

    # Stage c works on the migrated data: a team, a member, and a stage b map moved into the team.
    assert anna.post("/api/teams", json={"name": "Altes Team", "handle": "team-b"}).status_code == 201
    with upgraded["pool"].connection() as conn:
        conn.execute("INSERT INTO memberships (organization_id, user_id, role)"
                     " SELECT o.id, u.id, 'reader' FROM owners o, owners u WHERE o.handle = 'team-b' AND u.handle = 'bert-b'")
    moved = anna.post(f"/api/maps/{upgraded['maps']['geteilt']}/move", json={"team": "team-b"}).json()
    assert moved["owner"] == "team-b" and moved["visibility"] == "private"
    assert visitor.get(f"/api/shared/{token}/docs").status_code == 404
    assert bert.get(f"/api/maps/{upgraded['maps']['geteilt']}/access").json() == {"canWrite": False, "role": "reader"}
    response = anna.post("/api/teams", json={"name": "x", "handle": "bert-b"})
    assert response.status_code == 409 and response.json()["error"] == "handle_taken"


# The columns that 0002_embed adds to the old table maps, with the values that every old map gets.
EMBED_DEFAULTS = {"embed_allow": "all", "embed_origins": []}
# The column that 0004_language adds to the table users.
LANGUAGE = ("language",)
# The column that 0007_start_map adds to the table owners. No old owner has a start map.
START_MAP = ("start_map_id",)


def _without(rows: list[dict], columns) -> list[dict]:
    """The rows without the given columns, in the order of _snapshot."""
    return sorted(({k: v for k, v in row.items() if k not in columns} for row in rows),
                  key=lambda row: repr(sorted(row.items())))


def _owners_stay(before: list[dict], after: list[dict]) -> bool:
    """Every old owner keeps every old column, and gets no start map from 0007_start_map."""
    return (len(after) == len(before) > 0 and _without(after, START_MAP) == _without(before, ())
            and all(row["start_map_id"] is None for row in after))


@pytest.fixture
def upgraded_from_0001():
    """A database with 0001_initial only, filled as the app of stage b wrote it before 0002_embed, then migrated."""
    _recreate(UPGRADE_DATABASE)
    conninfo = f"dbname={UPGRADE_DATABASE}"
    assert migrate(conninfo, until="0001_initial") == ["0001_initial"]
    with psycopg.connect(conninfo, row_factory=dict_row) as conn:
        data = _fill_stage_b(conn, embed=False)
        before = _snapshot(conn)
    assert migrate(conninfo) == ["0002_embed", "0003_teams", "0004_language", "0005_freed_handles",
                                 "0006_one_share_link", "0007_start_map"]
    with psycopg.connect(conninfo, row_factory=dict_row) as conn:
        after = _snapshot(conn)
        applied = [row["version"] for row in conn.execute("SELECT version FROM schema_migrations ORDER BY version")]
    pool = ConnectionPool(conninfo, min_size=1, max_size=4, kwargs={"row_factory": dict_row}, open=True)
    try:
        yield {"before": before, "after": after, "applied": applied, "pool": pool, "conninfo": conninfo, **data}
    finally:
        pool.close()
        with psycopg.connect("dbname=postgres", autocommit=True) as conn:
            conn.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(UPGRADE_DATABASE)))


def test_rows_of_0001_stay_through_0002_and_0003(upgraded_from_0001):
    before, after = upgraded_from_0001["before"], upgraded_from_0001["after"]
    assert upgraded_from_0001["applied"] == ["0001_initial", "0002_embed", "0003_teams", "0004_language",
                                             "0005_freed_handles", "0006_one_share_link", "0007_start_map"]
    assert "embed_allow" not in before["maps"][0], "the database of the fixture must not have the embed columns"
    for table in OLD_TABLES:
        if table in DELETED_BY_0006:
            assert len(before[table]) > 0 and after[table] == [], table
            continue
        assert len(after[table]) == len(before[table]) > 0, table
        if table == "maps":
            # Every old column keeps its value, and every old map gets the defaults of the new columns.
            assert _without(after["maps"], EMBED_DEFAULTS) == _without(before["maps"], ())
            assert all({k: row[k] for k in EMBED_DEFAULTS} == EMBED_DEFAULTS for row in after["maps"])
        elif table == "users":
            assert _without(after["users"], LANGUAGE) == _without(before["users"], ())
            assert all(row["language"] == "en" for row in after["users"])
        elif table == "owners":
            assert _owners_stay(before["owners"], after["owners"])
        else:
            assert after[table] == before[table], table
    assert migrate(upgraded_from_0001["conninfo"]) == []


def test_the_app_works_on_data_of_0001_after_the_migrations(upgraded_from_0001):
    up = upgraded_from_0001
    app = create_app(make_settings(up["conninfo"]), pool=up["pool"])
    anna = TestClient(app, base_url=BASE, headers=HEADERS)
    response = anna.post("/api/auth/login", json={"email": "anna-b@example.org", "password": PASSWORD})
    assert response.status_code == 200 and response.json()["handle"] == "anna-b"
    maps = {m["slug"]: m for m in anna.get("/api/maps").json()["maps"]}
    assert set(maps) == {"privat", "geteilt", "offen"}
    assert all(m["ownerType"] == "user" and m["role"] == "owner" and m["version"] == 3 for m in maps.values())
    assert maps["geteilt"]["shares"] == 0

    # The old maps have the embed defaults: every site may embed a public map, and only a public map has an address.
    assert maps["offen"]["embed"] == {"allow": "all", "origins": [], "url": f"{BASE}/e/anna-b/offen"}
    assert maps["privat"]["embed"] == {"allow": "all", "origins": [], "url": None}

    # Documents, polling and writes, as before.
    map_id = str(up["maps"]["privat"])
    docs = anna.get(f"/api/maps/{map_id}/docs").json()
    assert docs["version"] == 3 and docs["docs"] == [{"collection": "skills", "id": "python",
                                                      "data": {"name": "Python"}}]
    delta = anna.get(f"/api/maps/{map_id}/docs", params={"since": 2}).json()
    assert delta["deleted"] == [{"collection": "skills", "id": "cobol"}]
    assert anna.put(f"/api/maps/{map_id}/docs/skills/rust", json={"name": "Rust"}).json() == {"version": 4}
    exported = anna.get(f"/api/maps/{map_id}/export").json()
    assert exported["collections"] == {"skills": {"python": {"name": "Python"}, "rust": {"name": "Rust"}}}

    # The session of stage b, and the public pages with the embed view of the public map. The share link of stage b
    # is gone (0006_one_share_link), and a new link and its embed view work.
    bert = TestClient(app, base_url=BASE, headers=HEADERS, cookies={"__Host-session": SESSION_TOKEN})
    assert bert.get("/api/account").json()["handle"] == "bert-b"
    visitor = TestClient(app, base_url=BASE, headers=HEADERS)
    assert visitor.get(f"/api/shared/{SHARE_TOKEN}/docs").status_code == 404
    token = anna.post(f"/api/maps/{up['maps']['geteilt']}/shares").json()["token"]
    assert visitor.get(f"/api/shared/{token}/docs").json()["docs"][0]["id"] == "python"
    assert visitor.get("/anna-b/offen").status_code == 200
    assert visitor.get("/anna-b/privat").status_code == 404
    embed = visitor.get("/e/anna-b/offen")
    assert embed.status_code == 200 and embed.headers["content-security-policy"] == site_policy("*")
    assert visitor.get("/e/anna-b/privat").status_code == 404
    assert visitor.get(f"/e/s/{SHARE_TOKEN}").status_code == 404
    assert visitor.get(f"/e/s/{token}").status_code == 200

    # The new columns take a change: an origin list for the public map.
    offen = str(up["maps"]["offen"])
    changed = anna.patch(f"/api/maps/{offen}", json={"embed": {"allow": "origins", "origins": ["https://cv.example.org"]}})
    assert changed.status_code == 200 and changed.json()["embed"]["origins"] == ["https://cv.example.org"]
    policy = visitor.get("/e/anna-b/offen").headers["content-security-policy"]
    assert policy == site_policy("'self' https://cv.example.org")

    # Stage c on the data of 0001: a team, and an old map that moves into it and arrives private.
    assert anna.post("/api/teams", json={"name": "Altes Team", "handle": "team-b"}).status_code == 201
    moved = anna.post(f"/api/maps/{offen}/move", json={"team": "team-b"}).json()
    assert moved["owner"] == "team-b" and moved["visibility"] == "private"
    assert moved["embed"] == {"allow": "origins", "origins": [], "url": None}
    assert visitor.get("/e/team-b/offen").status_code == 404


# The tables of stage c, which 0004_language keeps as they are too.
STAGE_C_TABLES = OLD_TABLES + ("organizations", "memberships", "invitations")
INVITATION_TOKEN = "stage-c-invitation-token-0123456789abcdef"


def _fill_stage_c(conn) -> dict:
    """The data of stage b, and a team of Anna with Bert as a reader, a map of the team and an open invitation."""
    data = _fill_stage_b(conn)
    ids = {row["handle"]: row["id"] for row in conn.execute("SELECT id, handle FROM owners WHERE kind = 'user'")}
    team = conn.execute("INSERT INTO owners (kind, handle) VALUES ('organization', 'team-c') RETURNING id").fetchone()["id"]
    conn.execute("INSERT INTO organizations (id, name, created_by) VALUES (%s, 'Team C', %s)", (team, ids["anna-b"]))
    conn.execute("INSERT INTO memberships (organization_id, user_id, role) VALUES (%s, %s, 'owner'), (%s, %s, 'reader')",
                 (team, ids["anna-b"], team, ids["bert-b"]))
    conn.execute("INSERT INTO maps (owner_id, created_by, title, slug, visibility) VALUES (%s, %s, 'Teamkarte', 'team', 'public')",
                 (team, ids["anna-b"]))
    conn.execute("INSERT INTO invitations (organization_id, email, role, token_hash, invited_by, expires_at)"
                 " VALUES (%s, 'cleo-c@example.org', 'editor', %s, %s, now() + interval '7 days')",
                 (team, hash_token(INVITATION_TOKEN), ids["anna-b"]))
    return {**data, "team": team}


def _snapshot_c(conn) -> dict:
    return {table: sorted(conn.execute(f"SELECT * FROM {table}").fetchall(), key=lambda row: repr(sorted(row.items())))
            for table in STAGE_C_TABLES}


@pytest.fixture
def upgraded_from_0003():
    """A database of stage c (0001 to 0003) with data, migrated to 0004_language, 0005_freed_handles and
    0006_one_share_link."""
    _recreate(UPGRADE_DATABASE)
    conninfo = f"dbname={UPGRADE_DATABASE}"
    assert migrate(conninfo, until="0003_teams") == ["0001_initial", "0002_embed", "0003_teams"]
    with psycopg.connect(conninfo, row_factory=dict_row) as conn:
        data = _fill_stage_c(conn)
        before = _snapshot_c(conn)
    assert migrate(conninfo) == ["0004_language", "0005_freed_handles", "0006_one_share_link",
                                 "0007_start_map"]
    with psycopg.connect(conninfo, row_factory=dict_row) as conn:
        after = _snapshot_c(conn)
    pool = ConnectionPool(conninfo, min_size=1, max_size=4, kwargs={"row_factory": dict_row}, open=True)
    try:
        yield {"before": before, "after": after, "pool": pool, "conninfo": conninfo, **data}
    finally:
        pool.close()
        with psycopg.connect("dbname=postgres", autocommit=True) as conn:
            conn.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(UPGRADE_DATABASE)))


def test_rows_of_0003_stay_through_0004(upgraded_from_0003):
    before, after = upgraded_from_0003["before"], upgraded_from_0003["after"]
    assert "language" not in before["users"][0], "the database of the fixture must not have the language yet"
    for table in STAGE_C_TABLES:
        if table in DELETED_BY_0006:
            assert len(before[table]) > 0 and after[table] == [], table
            continue
        assert len(after[table]) == len(before[table]) > 0, table
        if table == "users":
            # Every old column keeps its value, and every account gets English.
            assert _without(after["users"], LANGUAGE) == _without(before["users"], ())
            assert all(row["language"] == "en" for row in after["users"])
        elif table == "owners":
            assert _owners_stay(before["owners"], after["owners"])
        else:
            assert after[table] == before[table], table
    assert migrate(upgraded_from_0003["conninfo"]) == []
    with upgraded_from_0003["pool"].connection() as conn, pytest.raises(psycopg.errors.CheckViolation):
        conn.execute("UPDATE users SET language = 'Deutsch'")


def test_0005_adds_an_empty_table_of_freed_handles(upgraded_from_0003):
    """The old data freed no handle with a hold, so the table starts empty. A rename of the old team fills it."""
    up = upgraded_from_0003
    with up["pool"].connection() as conn:
        assert conn.execute("SELECT count(*) AS n FROM freed_handles").fetchone()["n"] == 0
    app = create_app(make_settings(up["conninfo"]), pool=up["pool"])
    anna = TestClient(app, base_url=BASE, headers=HEADERS)
    assert anna.post("/api/auth/login", json={"email": "anna-b@example.org", "password": PASSWORD}).status_code == 200
    assert anna.patch("/api/teams/team-c", json={"handle": "team-c2"}).status_code == 200
    response = TestClient(app, base_url=BASE, headers=HEADERS).post(
        "/api/auth/register", json={"email": f"{unique()}@example.org", "password": PASSWORD, "handle": "team-c"})
    assert response.status_code == 409 and response.json()["error"] == "handle_taken"


def test_0007_gives_no_old_owner_a_start_map_and_an_old_map_becomes_one(upgraded_from_0003):
    """Every old owner shows the list of its public maps, as before. An old map of a user and of a team becomes the start
    map of its owner."""
    up = upgraded_from_0003
    app = create_app(make_settings(up["conninfo"]), pool=up["pool"])
    anna = TestClient(app, base_url=BASE, headers=HEADERS)
    assert anna.post("/api/auth/login", json={"email": "anna-b@example.org", "password": PASSWORD}).status_code == 200
    visitor = TestClient(app, base_url=BASE, headers=HEADERS)
    for handle, slug in (("anna-b", "offen"), ("team-c", "team")):
        listing = visitor.get(f"/{handle}")
        assert listing.status_code == 200 and f'href="/{handle}/{slug}"' in listing.text, handle
    offen = str(up["maps"]["offen"])
    assert anna.patch(f"/api/maps/{offen}", json={"start": True}).json()["start"] is True
    team_map = anna.get("/api/teams/team-c/maps").json()["maps"][0]
    assert team_map["start"] is False and anna.patch(f"/api/maps/{team_map['id']}", json={"start": True}).json()["start"] is True
    for handle, slug in (("anna-b", "offen"), ("team-c", "team")):
        page = visitor.get(f"/{handle}")
        assert page.status_code == 200 and f'"slug": "{slug}"' in page.text and '"mode": "public"' in page.text, handle


def test_the_app_works_on_data_of_0003_after_0004(upgraded_from_0003, mailbox):
    up = upgraded_from_0003
    app = create_app(make_settings(up["conninfo"]), pool=up["pool"])
    # Each run of the test has its own mail addresses, so that a mail of an earlier run never counts.
    anna_mail, bert_mail = f"{unique('anna')}@example.org", f"{unique('bert')}@example.org"
    with up["pool"].connection() as conn:
        conn.execute("UPDATE users SET email = %s WHERE id = (SELECT id FROM owners WHERE handle = 'anna-b')", (anna_mail,))
        conn.execute("UPDATE users SET email = %s WHERE id = (SELECT id FROM owners WHERE handle = 'bert-b')", (bert_mail,))
    anna = TestClient(app, base_url=BASE, headers=HEADERS)
    login = anna.post("/api/auth/login", json={"email": anna_mail, "password": PASSWORD})
    assert login.status_code == 200 and login.json() == {"handle": "anna-b", "email": anna_mail, "language": "en"}
    assert anna.get("/api/auth/session").json()["language"] == "en"

    # The language of an account changes, and an unknown language changes nothing.
    changed = anna.patch("/api/account", json={"language": "de"})
    assert changed.status_code == 200 and changed.json()["language"] == "de" and changed.json()["handle"] == "anna-b"
    refused = anna.patch("/api/account", json={"language": "fr"})
    assert refused.status_code == 400 and refused.json()["error"] == "bad_language"
    assert refused.json()["params"] == {"languages": "en, de"}
    assert anna.get("/api/account").json()["language"] == "de"

    # The team of stage c still works, and its open invitation too.
    team = anna.get("/api/teams/team-c").json()
    assert [(m["handle"], m["role"]) for m in team["members"]] == [("anna-b", "owner"), ("bert-b", "reader")]
    visitor = TestClient(app, base_url=BASE, headers=HEADERS)
    assert visitor.post("/api/invitations/lookup", json={"token": INVITATION_TOKEN}).json()["role"] == "editor"
    assert visitor.get("/team-c/team").status_code == 200

    # Each mail takes the language of its recipient: German for Anna, English for Bert, whom German Anna invites.
    anna.post("/api/auth/reset-request", json={"email": anna_mail})
    reset = mailbox.wait(anna_mail, "Neues Passwort")
    assert reset["Subject"] == "Neues Passwort für it-skills.test" and "#reset=" in reset["Text"]
    assert anna.delete("/api/teams/team-c/members/bert-b").status_code == 204
    assert anna.post("/api/teams/team-c/invitations", json={"email": bert_mail, "role": "editor"}).status_code == 201
    invitation = mailbox.wait(bert_mail, "Invitation")
    assert invitation["Subject"] == "Invitation to the team Team C at it-skills.test"
    assert re.search(r"with the role editor\.", invitation["Text"]) and "#invite=" in invitation["Text"]


# The last migration before 0006_one_share_link, whatever its number.
BEFORE_0006 = max(path.stem for path in MIGRATIONS.glob("*.sql") if path.stem < "0006")


@pytest.fixture
def upgraded_to_0006():
    """A database at the migration before 0006_one_share_link, filled with the data of stage c and with old links as
    the server wrote them then: only the hash of each token. The map "geteilt" has two links, which was allowed then.
    The fixture runs 0006_one_share_link, takes the rows, and then runs the files after it, so that the app runs on
    the newest schema."""
    _recreate(UPGRADE_DATABASE)
    conninfo = f"dbname={UPGRADE_DATABASE}"
    assert migrate(conninfo, until=BEFORE_0006)[-1] == BEFORE_0006
    with psycopg.connect(conninfo, row_factory=dict_row) as conn:
        data = _fill_stage_c(conn)
        anna = conn.execute("SELECT id FROM owners WHERE handle = 'anna-b'").fetchone()["id"]
        for map_id, token in ((data["maps"]["geteilt"], OLD_TOKENS[0]), (data["maps"]["offen"], OLD_TOKENS[1])):
            conn.execute("INSERT INTO share_links (map_id, token_hash, created_by) VALUES (%s, %s, %s)",
                         (map_id, hash_token(token), anna))
        before = _snapshot_c(conn)
    assert migrate(conninfo, until="0006_one_share_link") == ["0006_one_share_link"]
    with psycopg.connect(conninfo, row_factory=dict_row) as conn:
        after = _snapshot_c(conn)
    migrate(conninfo)
    pool = ConnectionPool(conninfo, min_size=1, max_size=4, kwargs={"row_factory": dict_row}, open=True)
    try:
        yield {"before": before, "after": after, "pool": pool, "conninfo": conninfo, **data}
    finally:
        pool.close()
        with psycopg.connect("dbname=postgres", autocommit=True) as conn:
            conn.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(UPGRADE_DATABASE)))


OLD_TOKENS = ("old-share-token-two-0123456789abcdef", "old-share-token-public-0123456789abcdef")


def test_0006_deletes_the_old_links_and_keeps_every_other_row(upgraded_to_0006):
    before, after = upgraded_to_0006["before"], upgraded_to_0006["after"]
    assert len(before["share_links"]) == 3 and after["share_links"] == []
    for table in STAGE_C_TABLES:
        if table != "share_links":
            assert after[table] == before[table], table
    with upgraded_to_0006["pool"].connection() as conn:
        column = conn.execute("SELECT is_nullable FROM information_schema.columns"
                              " WHERE table_name = 'share_links' AND column_name = 'token'").fetchone()
        unique = conn.execute("SELECT indexdef FROM pg_indexes WHERE tablename = 'share_links'"
                              " AND indexname = 'share_links_one_per_map'").fetchone()
    assert column == {"is_nullable": "NO"}
    assert unique and unique["indexdef"].startswith("CREATE UNIQUE INDEX") and unique["indexdef"].endswith("(map_id)")
    assert migrate(upgraded_to_0006["conninfo"]) == []


def test_after_0006_old_links_are_dead_and_a_new_link_is_the_only_one(upgraded_to_0006):
    up = upgraded_to_0006
    app = create_app(make_settings(up["conninfo"]), pool=up["pool"])
    anna = TestClient(app, base_url=BASE, headers=HEADERS)
    assert anna.post("/api/auth/login", json={"email": "anna-b@example.org", "password": PASSWORD}).status_code == 200
    maps = {m["slug"]: m for m in anna.get("/api/maps").json()["maps"]}
    assert all(m["shares"] == 0 for m in maps.values())
    visitor = TestClient(app, base_url=BASE, headers=HEADERS)
    for token in (SHARE_TOKEN, *OLD_TOKENS):
        for path in (f"/s/{token}", f"/e/s/{token}", f"/api/shared/{token}", f"/api/shared/{token}/docs"):
            assert visitor.get(path).status_code == 404, path
    geteilt = str(up["maps"]["geteilt"])
    assert anna.get(f"/api/maps/{geteilt}/shares").json() == {"visibility": "link", "shares": []}
    share = anna.post(f"/api/maps/{geteilt}/shares").json()
    assert anna.get(f"/api/maps/{geteilt}/shares").json()["shares"][0]["url"] == share["url"]
    assert visitor.get(f"/s/{share['token']}").status_code == 200
    with up["pool"].connection() as conn, pytest.raises(psycopg.errors.UniqueViolation):
        conn.execute("INSERT INTO share_links (map_id, token_hash, token) VALUES (%s, %s, 'second')",
                     (geteilt, hash_token("second")))
