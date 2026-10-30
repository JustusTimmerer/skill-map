"""The limits of an owner under parallel requests: MAX_MAPS_PER_OWNER for new maps, imports and moves into a team,
MAX_TEAMS_PER_USER for new teams and accepted invitations with the role owner, and parallel new maps with one title.
Each count runs under a lock on the row of the owner (store.lock_owner), so parallel requests count one after the other.

Each test holds an outside lock first, so that every request stops at a lock of its own and all of them run at the same
moment once the outside lock goes. The lock order of the owner rows also keeps a move and the delete of an account from
waiting for each other in a circle. The lock order of a team (teams.py) does the same for the delete of a team and an
invitation that somebody accepts or sends at that moment."""
from __future__ import annotations

import psycopg
import pytest
from conftest import PASSWORD, Background, count_rows, make_settings, unique, wait_for_locks
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from app.main import create_app
from app.security import hash_token, new_token


@pytest.fixture
def wide(database):
    """An app with its own pool, large enough for 8 parallel requests and the connection of wait_for_locks."""
    pool = ConnectionPool(database, min_size=1, max_size=16, kwargs={"row_factory": dict_row}, open=True)

    def make(**changes):
        return create_app(make_settings(database, **changes), pool=pool)

    make.pool = pool
    yield make
    pool.close()


def as_user(make_client, app, user):
    """A new client of app with the session of a quick_user."""
    return make_client(app, cookies={"__Host-session": user.cookies.get("__Host-session")})


def at_once(database, pool, calls, rows):
    """Runs the calls at the same moment. rows names (table, ids) to lock FOR UPDATE from outside until every call waits
    for a lock."""
    with psycopg.connect(database) as hold:
        for table, ids in rows:
            hold.execute(f"SELECT 1 FROM {table} WHERE id = ANY(%s) FOR UPDATE", (ids,))
        running = [Background(call) for call in calls]
        wait_for_locks(pool, len(calls))
        hold.rollback()
    return [call.result() for call in running]


def team_id(pool, handle):
    with pool.connection() as conn:
        return conn.execute("SELECT id FROM owners WHERE handle = %s", (handle,)).fetchone()["id"]


def test_parallel_new_maps_and_imports_stop_at_the_limit(wide, make_client, quick_user, pool, database, sample_file):
    anna = quick_user()
    assert anna.post("/api/maps", json={"title": "Schon da"}).status_code == 201
    app = wide(max_maps=3)
    calls = [lambda n=n: as_user(make_client, app, anna).post("/api/maps", json={"title": f"Neu {n}"}) for n in range(4)]
    calls += [lambda: as_user(make_client, app, anna).post("/api/maps/import", json=sample_file) for _ in range(2)]
    answers = at_once(database, wide.pool, calls, [("owners", [anna.user_id])])
    assert sorted(a.status_code for a in answers) == [201, 201, 409, 409, 409, 409]
    assert {a.json()["error"] for a in answers if a.status_code == 409} == {"too_many_maps"}
    assert count_rows(pool, "maps", "owner_id = %s", (anna.user_id,)) == 3


def test_parallel_moves_and_new_maps_of_a_team_stop_at_the_limit(wide, make_client, quick_user, pool, database):
    anna = quick_user()
    team = unique("t")
    assert anna.post("/api/teams", json={"name": "Team", "handle": team}).status_code == 201
    own = [anna.post("/api/maps", json={"title": f"Eigen {n}"}).json()["id"] for n in range(3)]
    app = wide(max_maps=3)
    calls = [lambda m=m: as_user(make_client, app, anna).post(f"/api/maps/{m}/move", json={"team": team}) for m in own]
    calls += [lambda n=n: as_user(make_client, app, anna).post("/api/maps", json={"title": f"Team {n}", "team": team})
              for n in range(3)]
    answers = at_once(database, wide.pool, calls, [("owners", [team_id(pool, team)])])
    # A move answers 200 and a new map 201: exactly three of the six get through.
    statuses = [a.status_code for a in answers]
    assert sum(s in (200, 201) for s in statuses) == 3 and statuses.count(409) == 3, [a.text for a in answers]
    assert {a.json()["error"] for a in answers if a.status_code == 409} == {"too_many_maps"}
    assert count_rows(pool, "maps", "owner_id = %s", (team_id(pool, team),)) == 3


def test_parallel_new_teams_stop_at_the_limit(wide, make_client, quick_user, pool, database):
    anna = quick_user()
    assert anna.post("/api/teams", json={"name": "Erstes", "handle": unique("t")}).status_code == 201
    app = wide(max_teams=3)
    calls = [lambda: as_user(make_client, app, anna).post("/api/teams", json={"name": "Team", "handle": unique("t")})
             for _ in range(6)]
    # The users row too: without the lock of the owner row, a new team waits there, after its count.
    answers = at_once(database, wide.pool, calls, [("owners", [anna.user_id]), ("users", [anna.user_id])])
    assert sorted(a.status_code for a in answers) == [201, 201, 409, 409, 409, 409]
    assert {a.json()["error"] for a in answers if a.status_code == 409} == {"too_many_teams"}
    assert count_rows(pool, "memberships", "user_id = %s AND role = 'owner'", (anna.user_id,)) == 3


def test_eight_parallel_new_maps_with_one_title_get_distinct_slugs(wide, make_client, quick_user, pool, database):
    """Each slug that the server picks waits for the maps before it, so no request runs out of tries (slug_taken)."""
    anna = quick_user()
    app = wide()
    calls = [lambda: as_user(make_client, app, anna).post("/api/maps", json={"title": "Gleicher Titel"})
             for _ in range(8)]
    answers = at_once(database, wide.pool, calls, [("owners", [anna.user_id])])
    assert [a.status_code for a in answers] == [201] * 8, [a.text for a in answers]
    slugs = sorted(a.json()["slug"] for a in answers)
    assert slugs == sorted(["gleicher-titel"] + [f"gleicher-titel-{n}" for n in range(2, 9)])


def test_a_move_and_the_delete_of_the_account_do_not_wait_for_each_other(wide, make_client, quick_user, pool, database):
    """Anna deletes her account, which deletes her team, while she moves a map into that team. The delete locks the
    team and then reaches her maps. The move locks the team before its map, so it waits for the delete and does not hold
    the map that the delete needs. The move then finds no team."""
    anna = quick_user()
    team = unique("t")
    assert anna.post("/api/teams", json={"name": "Allein", "handle": team}).status_code == 201
    own = anna.post("/api/maps", json={"title": "Eigen"}).json()["id"]
    app = wide()
    with psycopg.connect(database) as hold:
        hold.execute("SELECT 1 FROM owners WHERE id = %s FOR UPDATE", (team_id(pool, team),))
        delete = Background(lambda: as_user(make_client, app, anna).post("/api/account/delete",
                                                                         json={"password": PASSWORD}))
        wait_for_locks(wide.pool, 1)
        move = Background(lambda: as_user(make_client, app, anna).post(f"/api/maps/{own}/move", json={"team": team}))
        wait_for_locks(wide.pool, 2)
        hold.rollback()
    deleted, moved = delete.result(), move.result()
    assert deleted.status_code == 204, deleted.text
    assert moved.status_code == 404 and moved.json()["error"] == "not_found", moved.text
    assert count_rows(pool, "owners", "id = %s", (anna.user_id,)) == 0
    assert count_rows(pool, "maps") == 0


def test_a_new_team_and_the_delete_of_the_account_leave_no_team_without_members(wide, make_client, quick_user, pool,
                                                                                 database):
    """Anna creates a team while she deletes her account. The delete locks her owner row first, as the new team does,
    so it counts the new team too and deletes it with the account."""
    anna = quick_user()
    app = wide()
    with psycopg.connect(database) as hold:
        hold.execute("SELECT 1 FROM users WHERE id = %s FOR UPDATE", (anna.user_id,))
        create = Background(lambda: as_user(make_client, app, anna).post(
            "/api/teams", json={"name": "Neu", "handle": unique("t")}))
        wait_for_locks(wide.pool, 1)
        delete = Background(lambda: as_user(make_client, app, anna).post("/api/account/delete",
                                                                         json={"password": PASSWORD}))
        wait_for_locks(wide.pool, 2)
        hold.rollback()
    assert create.result().status_code == 201
    assert delete.result().status_code == 204
    assert count_rows(pool, "organizations o", "NOT EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id = o.id)") == 0
    assert count_rows(pool, "organizations") == 0


def open_invitation(pool, team_handle, email, role, inviter) -> str:
    """An open invitation of a team, written straight into the database. Returns its token."""
    token = new_token()
    with pool.connection() as conn:
        conn.execute(
            "INSERT INTO invitations (organization_id, email, role, token_hash, invited_by, expires_at)"
            " SELECT id, %s, %s, %s, %s, now() + interval '1 day' FROM owners WHERE handle = %s",
            (email, role, hash_token(token), inviter.user_id, team_handle),
        )
    return token


def test_parallel_owner_invitations_and_new_teams_stop_at_the_limit(wide, make_client, quick_user, pool, database):
    """An accepted invitation with the role owner counts against MAX_TEAMS_PER_USER under the lock of the row of the user,
    as a new team does. Bert accepts four invitations as owner and creates two teams at the same moment. He leads one
    team already, and the limit is 3, so exactly two of the six get through."""
    anna, bert = quick_user(), quick_user()
    assert bert.post("/api/teams", json={"name": "Eigenes", "handle": unique("t")}).status_code == 201
    teams = [unique("t") for _ in range(4)]
    for handle in teams:
        assert anna.post("/api/teams", json={"name": "Team", "handle": handle}).status_code == 201
    tokens = [open_invitation(pool, handle, bert.email, "owner", anna) for handle in teams]
    app = wide(max_teams=3)
    calls = [lambda t=t: as_user(make_client, app, bert).post("/api/invitations/accept", json={"token": t})
             for t in tokens]
    calls += [lambda: as_user(make_client, app, bert).post("/api/teams", json={"name": "Neu", "handle": unique("t")})
              for _ in range(2)]
    # The users row too: without the lock of the owner row, an accept waits there, after its count.
    answers = at_once(database, wide.pool, calls, [("owners", [bert.user_id]), ("users", [bert.user_id])])
    statuses = [a.status_code for a in answers]
    assert sum(s in (200, 201) for s in statuses) == 2 and statuses.count(409) == 4, [a.text for a in answers]
    assert {a.json()["error"] for a in answers if a.status_code == 409} == {"too_many_teams"}
    assert count_rows(pool, "memberships", "user_id = %s AND role = 'owner'", (bert.user_id,)) == 3


@pytest.mark.parametrize("first", ["delete", "accept"])
def test_an_accepted_invitation_and_the_delete_of_the_team_do_not_wait_for_each_other(wide, make_client, quick_user,
                                                                                       pool, database, first):
    """Anna deletes her team while Bert accepts an invitation into it. Both lock the row of the team before the
    invitation, so they run one after the other, and neither gets an error 500 from a deadlock.

    delete: an outside lock holds the delete after it locked the team and before its delete reaches the invitation. Then
    the accept starts. It waits for the team, and after the delete it finds no invitation.
    accept: an outside lock holds the accept after it locked the team and the invitation. Then the delete starts. It
    waits, and then it deletes the team with its new member."""
    anna, bert = quick_user(), quick_user()
    team = unique("t")
    assert anna.post("/api/teams", json={"name": "Team", "handle": team}).status_code == 201
    token = open_invitation(pool, team, bert.email, "editor", anna)
    app = wide()
    requests = {
        "delete": lambda: as_user(make_client, app, anna).post(f"/api/teams/{team}/delete", json={"password": PASSWORD}),
        "accept": lambda: as_user(make_client, app, bert).post("/api/invitations/accept", json={"token": token}),
    }
    second = "accept" if first == "delete" else "delete"
    with psycopg.connect(database) as hold:
        if first == "delete":
            # The delete of the owner row of the team waits for this lock.
            hold.execute("SELECT 1 FROM owners WHERE id = %s FOR KEY SHARE", (team_id(pool, team),))
        else:
            # The new membership of Bert waits for this lock: the check of its foreign key to users.
            hold.execute("SELECT 1 FROM users WHERE id = %s FOR UPDATE", (bert.user_id,))
        calls = {first: Background(requests[first])}
        wait_for_locks(wide.pool, 1)
        calls[second] = Background(requests[second])
        wait_for_locks(wide.pool, 2)
        hold.rollback()
    deleted, accepted = calls["delete"].result(), calls["accept"].result()
    assert deleted.status_code == 204, deleted.text
    if first == "delete":
        assert accepted.status_code == 400 and accepted.json()["error"] == "invalid_token", accepted.text
    else:
        assert accepted.status_code == 200, accepted.text
    assert count_rows(pool, "organizations") == 0
    assert count_rows(pool, "memberships") == 0 and count_rows(pool, "invitations") == 0


def test_an_invitation_and_the_delete_of_the_team_do_not_wait_for_each_other(wide, make_client, quick_user, pool,
                                                                              database):
    """Anna deletes her team while she invites an address again. The new invitation replaces the open one, so it locks
    that row. It locks the row of the team first, as the delete does. So it waits for the delete and then finds no team
    (404), instead of a deadlock or a failed foreign key (500)."""
    anna = quick_user()
    team = unique("t")
    assert anna.post("/api/teams", json={"name": "Team", "handle": team}).status_code == 201
    email = f"{unique()}@example.org"
    open_invitation(pool, team, email, "reader", anna)
    app = wide()
    with psycopg.connect(database) as hold:
        hold.execute("SELECT 1 FROM owners WHERE id = %s FOR KEY SHARE", (team_id(pool, team),))
        delete = Background(lambda: as_user(make_client, app, anna).post(f"/api/teams/{team}/delete",
                                                                         json={"password": PASSWORD}))
        wait_for_locks(wide.pool, 1)
        invite = Background(lambda: as_user(make_client, app, anna).post(f"/api/teams/{team}/invitations",
                                                                         json={"email": email, "role": "editor"}))
        wait_for_locks(wide.pool, 2)
        hold.rollback()
    deleted, invited = delete.result(), invite.result()
    assert deleted.status_code == 204, deleted.text
    assert invited.status_code == 404 and invited.json()["error"] == "not_found", invited.text
    assert count_rows(pool, "organizations") == 0 and count_rows(pool, "invitations") == 0
