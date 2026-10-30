"""Freed handles stay blocked (migration 0005_freed_handles, app/handles.py). A handle is also a public address:
/<handle>/..., the embed view /e/<handle>/<slug> in frames on other sites, and the subdomain <handle>.<domain>. A team
rename, a team delete and an account delete free a handle. It then stays blocked for HANDLE_HOLD_DAYS, so that no
stranger takes over the old addresses. The owner that freed it may take it back. An account that nobody confirmed never
had a public page, so it blocks nothing."""
from __future__ import annotations

import pytest
from conftest import BASE, PASSWORD, count_rows, unique

from app.config import Settings


def register(client, handle, email=None, password=PASSWORD):
    email = email or f"{unique()}@example.org"
    return client.post("/api/auth/register", json={"email": email, "password": password, "handle": handle})


def new_team(client, handle=None):
    handle = handle or unique("t")
    response = client.post("/api/teams", json={"name": "Team", "handle": handle})
    assert response.status_code == 201, response.text
    return handle


def rename(client, team, handle):
    return client.patch(f"/api/teams/{team}", json={"handle": handle})


def holds(pool) -> dict:
    with pool.connection() as conn:
        return {row["handle"]: row["owner_id"] for row in conn.execute("SELECT handle, owner_id FROM freed_handles")}


def owner_id(pool, handle):
    with pool.connection() as conn:
        return conn.execute("SELECT id FROM owners WHERE handle = %s", (handle,)).fetchone()["id"]


def move_hold(pool, handle, days):
    """Moves the time of the hold back by days, as if the handle was freed that long ago."""
    with pool.connection() as conn:
        conn.execute("UPDATE freed_handles SET freed_at = now() - make_interval(days => %s) WHERE handle = %s",
                     (days, handle))


def assert_blocked(client, stranger, handle, taken):
    """Every way to a handle refuses it: a registration, a new team and the rename of a team of a stranger. Each answer
    equals the answer for the handle `taken`, which an owner has."""
    team = new_team(stranger)
    for attempt in (lambda h: register(client, h), lambda h: stranger.post("/api/teams", json={"name": "x", "handle": h}),
                    lambda h: rename(stranger, team, h)):
        held, used = attempt(handle), attempt(taken)
        assert held.status_code == used.status_code == 409, (handle, held.text)
        assert held.json() == used.json() == {"error": "handle_taken", "message": used.json()["message"], "params": {}}


def test_a_renamed_team_blocks_its_old_handle_and_takes_it_back(client, quick_user, pool):
    anna, bert = quick_user(), quick_user()
    old, new = unique("t"), unique("t")
    new_team(anna, old)
    team_id = owner_id(pool, old)
    assert rename(anna, old, new).status_code == 200
    assert holds(pool) == {old: team_id}
    assert_blocked(client, bert, old, taken=anna.handle)
    # The team that freed the handle takes it back. Then its other handle is held for it.
    response = rename(anna, new, old)
    assert response.status_code == 200 and response.json()["handle"] == old
    assert holds(pool) == {new: team_id}
    assert_blocked(client, bert, new, taken=old)
    assert anna.get(f"/{old}").status_code == 200


def test_a_deleted_team_blocks_its_handle(client, quick_user, pool):
    anna, bert = quick_user(), quick_user()
    handle = new_team(anna)
    team_id = owner_id(pool, handle)
    assert anna.post(f"/api/teams/{handle}/delete", json={"password": PASSWORD}).status_code == 204
    assert holds(pool) == {handle: team_id}
    assert_blocked(client, bert, handle, taken=anna.handle)
    # The owner of the deleted team is another owner than the team, so a new team of the same user cannot take it.
    response = anna.post("/api/teams", json={"name": "Again", "handle": handle})
    assert response.status_code == 409 and response.json()["error"] == "handle_taken"


def test_a_deleted_account_blocks_its_handle_and_the_handles_of_its_teams(client, quick_user, pool, signup, make_client):
    anna, bert = quick_user(), quick_user()
    team = new_team(anna)
    ids = {anna.handle: anna.user_id, team: owner_id(pool, team)}
    assert anna.post("/api/account/delete", json={"password": PASSWORD}).status_code == 204
    assert holds(pool) == ids
    for handle in ids:
        assert_blocked(client, bert, handle, taken=bert.handle)
    # An account that registers through the mail and deletes itself blocks its handle too.
    carla = make_client()
    account = signup(carla)
    assert carla.post("/api/account/delete", json={"password": PASSWORD}).status_code == 204
    assert account["handle"] in holds(pool)
    assert register(client, account["handle"]).json()["error"] == "handle_taken"


def test_the_hold_ends_after_handle_hold_days(client, quick_user, pool, make_app, make_client):
    anna, bert = quick_user(), quick_user()
    old = new_team(anna)
    assert rename(anna, old, unique("t")).status_code == 200
    # The default hold is 180 days: one day before its end the handle is still blocked.
    move_hold(pool, old, 179)
    assert register(client, old).status_code == 409
    move_hold(pool, old, 180)
    assert bert.post("/api/teams", json={"name": "Neu", "handle": old}).status_code == 201
    # The server deletes a row once its hold has ended, and the new owner has no row.
    assert holds(pool) == {}
    assert bert.get(f"/{old}").status_code == 200

    # HANDLE_HOLD_DAYS sets the length of the hold.
    short = make_app(handle_hold_days=2)
    carla = make_client(short, cookies={"__Host-session": anna.cookies.get("__Host-session")})
    team = new_team(carla)
    assert carla.post(f"/api/teams/{team}/delete", json={"password": PASSWORD}).status_code == 204
    move_hold(pool, team, 1)
    assert register(make_client(short), team).status_code == 409
    move_hold(pool, team, 2)
    assert register(make_client(short), team).status_code == 202
    # 0 turns the hold off.
    off = make_app(handle_hold_days=0)
    dora = make_client(off, cookies={"__Host-session": bert.cookies.get("__Host-session")})
    team = new_team(dora)
    assert dora.post(f"/api/teams/{team}/delete", json={"password": PASSWORD}).status_code == 204
    assert register(make_client(off), team).status_code == 202


def test_an_unconfirmed_account_blocks_no_handle(client, make_client, pool):
    """An account that nobody confirmed has no public page. A second registration that replaces it frees its handle at
    once, and so does the cleanup of an account that nobody confirmed for 7 days."""
    email = f"{unique()}@example.org"
    first, second = unique(), unique()
    assert register(client, first, email).status_code == 202
    assert register(client, second, email).status_code == 202
    assert register(make_client(), first).status_code == 202
    late = unique()
    assert register(client, late).status_code == 202
    with pool.connection() as conn:
        conn.execute("UPDATE users SET created_at = now() - interval '8 days' WHERE id = (SELECT id FROM owners"
                     " WHERE handle = %s)", (late,))
    assert register(make_client(), late).status_code == 202
    assert count_rows(pool, "freed_handles") == 0


def test_handle_hold_days_setting():
    assert Settings(base_url=BASE).handle_hold_days == 180
    assert Settings.from_env({"BASE_URL": BASE}).handle_hold_days == 180
    assert Settings.from_env({"BASE_URL": BASE, "HANDLE_HOLD_DAYS": "30"}).handle_hold_days == 30
    with pytest.raises(ValueError):
        Settings(base_url=BASE, handle_hold_days=-1)
