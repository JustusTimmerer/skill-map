"""Teams: create, rename and delete, one handle namespace with the users, roles and the last owner, leaving,
invitations by e-mail, maps of a team, the move of an own map, public team maps, and account deletes."""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta

import psycopg
import pytest
from conftest import BASE, PASSWORD, SUBJECTS, Background, count_rows, unique, wait_for_locks

from app.config import Limit
from app.security import hash_token


def new_team(client, handle=None, name="Mein Team"):
    handle = handle or unique("t")
    response = client.post("/api/teams", json={"name": name, "handle": handle})
    assert response.status_code == 201, response.text
    return response.json()


def add_member(pool, team_handle, client, role):
    with pool.connection() as conn:
        conn.execute(
            "INSERT INTO memberships (organization_id, user_id, role)"
            " SELECT id, %s, %s FROM owners WHERE handle = %s",
            (client.user_id, role, team_handle),
        )


def server_config(page: str) -> dict:
    match = re.search(r'<script type="application/json" id="it-skills-server">(.*?)</script>', page)
    assert match, page[:300]
    return json.loads(match[1])


def invite_token(mailbox, email: str, count: int = 1) -> str:
    text = mailbox.wait(email, SUBJECTS["invitation"], count)["Text"]
    match = re.search(r"#invite=([A-Za-z0-9_-]+)", text)
    assert match, text
    return match[1]


def test_create_list_and_view(quick_user):
    anna = quick_user()
    team = new_team(anna, name="Team Nord")
    assert team["role"] == "owner" and team["name"] == "Team Nord" and team["canManage"] is True
    assert team["profileUrl"] == f"{BASE}/{team['handle']}"
    assert team["siteUrl"] == f"https://{team['handle']}.it-skills.test"
    assert team["members"] == [{"handle": anna.handle, "role": "owner", "joined": team["created"]}]
    listed = anna.get("/api/teams").json()["teams"]
    assert [(t["handle"], t["role"], t["members"], t["maps"]) for t in listed] == [(team["handle"], "owner", 1, 0)]
    view = anna.get(f"/api/teams/{team['handle']}").json()
    assert view["members"] == team["members"] and view["canEdit"] is True
    # Capitals in a handle become small letters, as for users.
    assert anna.get(f"/api/teams/{team['handle'].upper()}").status_code == 200
    assert anna.get("/api/account").json()["teams"] == 1


def test_one_handle_namespace_with_the_users(quick_user, client):
    anna = quick_user()
    for handle, code in (("an", "invalid_handle"), ("-team", "invalid_handle"), ("a--b", "invalid_handle"),
                         ("www", "reserved_handle"), ("konto", "reserved_handle"), ("api", "reserved_handle")):
        response = anna.post("/api/teams", json={"name": "x", "handle": handle})
        assert response.status_code == 400 and response.json()["error"] == code, handle
    response = anna.post("/api/teams", json={"name": "x", "handle": anna.handle})
    assert response.status_code == 409 and response.json()["error"] == "handle_taken"
    team = new_team(anna)
    response = anna.post("/api/teams", json={"name": "x", "handle": team["handle"]})
    assert response.status_code == 409 and response.json()["error"] == "handle_taken"
    # A user cannot register with the handle of a team.
    response = client.post("/api/auth/register", json={"email": f"{unique()}@example.org", "password": PASSWORD,
                                                       "handle": team["handle"]})
    assert response.status_code == 409 and response.json()["error"] == "handle_taken"
    for name in ("", "   ", "x" * 101):
        response = anna.post("/api/teams", json={"name": name, "handle": unique("t")})
        assert response.status_code == 400 and response.json()["error"] == "invalid_name", name


def test_a_stale_registration_frees_its_handle_for_a_team(quick_user, client, pool):
    anna = quick_user()
    handle = unique("t")
    response = client.post("/api/auth/register", json={"email": f"{handle}@example.org", "password": PASSWORD,
                                                       "handle": handle})
    assert response.status_code == 202
    response = anna.post("/api/teams", json={"name": "x", "handle": handle})
    assert response.status_code == 409 and response.json()["error"] == "handle_taken"
    with pool.connection() as conn:
        conn.execute("UPDATE users SET created_at = now() - interval '8 days' WHERE email = %s",
                     (f"{handle}@example.org",))
    assert new_team(anna, handle)["handle"] == handle


def test_a_stale_registration_frees_its_handle_for_a_team_rename(quick_user, client, pool):
    """A new handle of a team frees the handle of an account that nobody confirmed for 7 days first, as a registration
    and a new team do."""
    anna = quick_user()
    team = new_team(anna)
    handle = unique("t")
    response = client.post("/api/auth/register", json={"email": f"{handle}@example.org", "password": PASSWORD,
                                                       "handle": handle})
    assert response.status_code == 202
    response = anna.patch(f"/api/teams/{team['handle']}", json={"handle": handle})
    assert response.status_code == 409 and response.json()["error"] == "handle_taken"
    with pool.connection() as conn:
        conn.execute("UPDATE users SET created_at = now() - interval '8 days' WHERE email = %s",
                     (f"{handle}@example.org",))
    response = anna.patch(f"/api/teams/{team['handle']}", json={"handle": handle})
    assert response.status_code == 200 and response.json()["handle"] == handle, response.text
    assert count_rows(pool, "users", "email = %s", (f"{handle}@example.org",)) == 0


def test_team_limit(make_app, make_client, quick_user):
    anna = quick_user()
    limited = make_client(make_app(max_teams=1), cookies=dict(anna.cookies))
    new_team(limited)
    response = limited.post("/api/teams", json={"name": "Zwei", "handle": unique("t")})
    assert response.status_code == 409 and response.json()["error"] == "too_many_teams"


def test_an_owner_invitation_counts_against_the_team_limit(make_app, make_client, quick_user, mailbox, pool):
    """An accepted invitation with the role owner makes the user an owner of one more team, so it counts against
    MAX_TEAMS_PER_USER as a new team does. The roles editor and reader do not count."""
    anna, bert = quick_user(), quick_user()
    first, second = new_team(anna), new_team(anna)
    new_team(bert)
    limited = make_client(make_app(max_teams=1), cookies=dict(bert.cookies))
    anna.post(f"/api/teams/{first['handle']}/invitations", json={"email": bert.email, "role": "reader"})
    accepted = limited.post("/api/invitations/accept", json={"token": invite_token(mailbox, bert.email)})
    assert accepted.status_code == 200 and accepted.json()["role"] == "reader", accepted.text
    anna.post(f"/api/teams/{second['handle']}/invitations", json={"email": bert.email, "role": "owner"})
    token = invite_token(mailbox, bert.email, count=2)
    response = limited.post("/api/invitations/accept", json={"token": token})
    assert response.status_code == 409 and response.json()["error"] == "too_many_teams", response.text
    assert response.json()["params"] == {"max": 1, "count": 1}
    assert [m["handle"] for m in anna.get(f"/api/teams/{second['handle']}").json()["members"]] == [anna.handle]
    # The invitation stays open: with room for one more team, the same link works.
    roomy = make_client(make_app(max_teams=2), cookies=dict(bert.cookies))
    accepted = roomy.post("/api/invitations/accept", json={"token": token})
    assert accepted.status_code == 200 and accepted.json()["role"] == "owner", accepted.text
    assert count_rows(pool, "memberships", "user_id = %s AND role = 'owner'", (bert.user_id,)) == 2


def test_a_new_owner_role_counts_against_the_team_limit(make_app, make_client, quick_user, pool):
    """A member who becomes an owner counts against MAX_TEAMS_PER_USER. The teams of that member count, not the teams
    of the owner who gives the role."""
    anna, bert = quick_user(), quick_user()
    team = new_team(anna)
    own = new_team(bert)
    add_member(pool, team["handle"], bert, "editor")
    # Anna leads one team as well, as many as this limit allows.
    limited = make_client(make_app(max_teams=1), cookies=dict(anna.cookies))
    path = f"/api/teams/{team['handle']}/members/{bert.handle}"
    response = limited.patch(path, json={"role": "owner"})
    assert response.status_code == 409 and response.json()["error"] == "too_many_teams", response.text
    assert response.json()["params"] == {"max": 1, "count": 1, "variant": "member"}
    roles = {m["handle"]: m["role"] for m in anna.get(f"/api/teams/{team['handle']}").json()["members"]}
    assert roles == {anna.handle: "owner", bert.handle: "editor"}
    assert limited.patch(path, json={"role": "reader"}).json()["role"] == "reader"
    assert bert.post(f"/api/teams/{own['handle']}/delete", json={"password": PASSWORD}).status_code == 204
    assert limited.patch(path, json={"role": "owner"}).json()["role"] == "owner"
    # The role owner once more is no new team.
    assert limited.patch(path, json={"role": "owner"}).status_code == 200


def test_rename_and_change_handle(quick_user, sample_file):
    anna = quick_user()
    team = new_team(anna)
    created = anna.post(f"/api/maps/import?team={team['handle']}", json=sample_file).json()
    anna.patch(f"/api/maps/{created['id']}", json={"visibility": "public"})
    token = anna.post(f"/api/maps/{created['id']}/shares").json()["token"]
    renamed = anna.patch(f"/api/teams/{team['handle']}", json={"name": "Neuer Name"}).json()
    assert renamed["name"] == "Neuer Name" and renamed["handle"] == team["handle"]
    new_handle = unique("t")
    moved = anna.patch(f"/api/teams/{team['handle']}", json={"handle": new_handle}).json()
    assert moved["handle"] == new_handle
    assert anna.get(f"/api/teams/{team['handle']}").status_code == 404
    assert anna.get(f"/{new_handle}/{created['slug']}").status_code == 200
    assert anna.get(f"/{team['handle']}/{created['slug']}").status_code == 404
    assert anna.get(f"/api/shared/{token}/docs").status_code == 200
    response = anna.patch(f"/api/teams/{new_handle}", json={"handle": anna.handle})
    assert response.status_code == 409 and response.json()["error"] == "handle_taken"
    response = anna.patch(f"/api/teams/{new_handle}", json={"handle": "admin"})
    assert response.status_code == 400 and response.json()["error"] == "reserved_handle"


def test_delete_needs_the_password_and_removes_the_maps(quick_user, pool, sample_file):
    anna = quick_user()
    team = new_team(anna)
    created = anna.post(f"/api/maps/import?team={team['handle']}", json=sample_file).json()
    token = anna.post(f"/api/maps/{created['id']}/shares").json()["token"]
    anna.post(f"/api/teams/{team['handle']}/invitations", json={"email": "x@example.org", "role": "reader"})
    own = anna.post("/api/maps", json={"title": "Bleibt"}).json()
    response = anna.post(f"/api/teams/{team['handle']}/delete", json={"password": "das ist falsch falsch"})
    assert response.status_code == 401 and response.json()["error"] == "wrong_password"
    assert anna.post(f"/api/teams/{team['handle']}/delete", json={"password": PASSWORD}).status_code == 204
    assert anna.get(f"/api/teams/{team['handle']}").status_code == 404
    assert anna.get(f"/api/maps/{created['id']}").status_code == 404
    assert anna.get(f"/api/shared/{token}/docs").status_code == 404
    for table in ("organizations", "memberships", "invitations"):
        assert count_rows(pool, table) == 0, table
    assert count_rows(pool, "documents", "map_id = %s", (created["id"],)) == 0
    assert [m["id"] for m in anna.get("/api/maps").json()["maps"]] == [own["id"]]
    assert anna.get("/api/teams").json()["teams"] == []


def test_roles_and_the_last_owner(quick_user, pool):
    anna, bert, cleo = quick_user(), quick_user(), quick_user()
    team = new_team(anna)
    add_member(pool, team["handle"], bert, "editor")
    add_member(pool, team["handle"], cleo, "reader")
    path = f"/api/teams/{team['handle']}/members"
    members = anna.get(f"/api/teams/{team['handle']}").json()["members"]
    assert [(m["handle"], m["role"]) for m in members] == [(anna.handle, "owner"), (bert.handle, "editor"),
                                                            (cleo.handle, "reader")]
    response = anna.patch(f"{path}/{anna.handle}", json={"role": "editor"})
    assert response.status_code == 409 and response.json()["error"] == "last_owner"
    response = anna.delete(f"{path}/{anna.handle}")
    assert response.status_code == 409 and response.json()["error"] == "last_owner"
    response = anna.patch(f"{path}/{bert.handle}", json={"role": "boss"})
    assert response.status_code == 400 and response.json()["error"] == "invalid_role"
    assert anna.patch(f"{path}/nobody-here", json={"role": "reader"}).status_code == 404
    assert anna.patch(f"{path}/{bert.handle}", json={"role": "owner"}).json()["role"] == "owner"
    # Now there are two owners, so Anna can step down and leave.
    assert anna.patch(f"{path}/{anna.handle}", json={"role": "reader"}).status_code == 200
    assert anna.get(f"/api/teams/{team['handle']}").json()["canManage"] is False
    assert anna.delete(f"{path}/{anna.handle}").status_code == 204
    assert anna.get(f"/api/teams/{team['handle']}").status_code == 404
    # A reader leaves; the owner removes nobody twice.
    assert cleo.delete(f"{path}/{cleo.handle}").status_code == 204
    assert bert.delete(f"{path}/{cleo.handle}").status_code == 404
    assert [m["handle"] for m in bert.get(f"/api/teams/{team['handle']}").json()["members"]] == [bert.handle]
    response = bert.delete(f"{path}/{bert.handle}")
    assert response.status_code == 409 and response.json()["error"] == "last_owner"


def test_invitation_by_mail(quick_user, make_client, mailbox, pool):
    anna = quick_user()
    team = new_team(anna, name="Team Süd")
    email = f"{unique()}@example.org"
    response = anna.post(f"/api/teams/{team['handle']}/invitations", json={"email": email, "role": "editor"})
    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "invited" and body["invitation"]["email"] == email
    invitation = body["invitation"]
    created = datetime.fromisoformat(invitation["created"].replace("Z", "+00:00"))
    expires = datetime.fromisoformat(invitation["expires"].replace("Z", "+00:00"))
    assert timedelta(days=7) - timedelta(seconds=5) <= expires - created <= timedelta(days=7, seconds=5)
    token = invite_token(mailbox, email)
    assert len(token) >= 22  # 32 random bytes, more than 128 bits
    with pool.connection() as conn:
        stored = conn.execute("SELECT token_hash FROM invitations WHERE id = %s", (invitation["id"],)).fetchone()
    assert bytes(stored["token_hash"]) == hash_token(token)
    assert anna.get(f"/api/teams/{team['handle']}/invitations").json()["invitations"] == [invitation]

    # The invitation shows the team and the role first, also without a session.
    visitor = make_client()
    shown = visitor.post("/api/invitations/lookup", json={"token": token}).json()
    assert shown == {"team": {"handle": team["handle"], "name": "Team Süd"}, "role": "editor",
                     "invitedBy": anna.handle, "expires": invitation["expires"], "memberRole": None}
    assert visitor.post("/api/invitations/accept", json={"token": token}).status_code == 401
    # Any account can accept: the e-mail address of the account does not matter.
    bert = quick_user()
    joined = bert.post("/api/invitations/accept", json={"token": token}).json()
    assert joined["role"] == "editor" and joined["handle"] == team["handle"]
    assert {m["handle"]: m["role"] for m in joined["members"]} == {anna.handle: "owner", bert.handle: "editor"}
    # Used once.
    for client in (bert, quick_user()):
        response = client.post("/api/invitations/accept", json={"token": token})
        assert response.status_code == 400 and response.json()["error"] == "invalid_token"
    assert visitor.post("/api/invitations/lookup", json={"token": token}).status_code == 400
    assert anna.get(f"/api/teams/{team['handle']}/invitations").json()["invitations"] == []


def test_invitation_rules(quick_user, mailbox, pool):
    anna = quick_user()
    team = new_team(anna)
    path = f"/api/teams/{team['handle']}/invitations"
    for body, code in (({"email": "kein-mail", "role": "reader"}, "invalid_email"),
                       ({"email": "a@example.org", "role": "admin"}, "invalid_role")):
        response = anna.post(path, json=body)
        assert response.status_code == 400 and response.json()["error"] == code
    # The answer is the same for an address with an account and one without.
    bert = quick_user()
    known = anna.post(path, json={"email": bert.email, "role": "reader"})
    unknown = anna.post(path, json={"email": f"{unique()}@example.org", "role": "reader"})
    assert known.status_code == unknown.status_code == 201
    assert {k: v for k, v in known.json().items() if k != "invitation"} == \
           {k: v for k, v in unknown.json().items() if k != "invitation"}
    assert set(known.json()["invitation"]) == set(unknown.json()["invitation"])
    # A second invitation to the same address replaces the first one.
    first = invite_token(mailbox, bert.email)
    anna.post(path, json={"email": bert.email.upper(), "role": "editor"})
    second = invite_token(mailbox, bert.email, count=2)
    assert first != second
    assert bert.post("/api/invitations/accept", json={"token": first}).status_code == 400
    open_ = anna.get(path).json()["invitations"]
    assert sorted(i["role"] for i in open_) == ["editor", "reader"]
    # Withdrawn invitations stop at once.
    withdrawn = next(i for i in open_ if i["email"] == bert.email)
    assert anna.delete(f"{path}/{withdrawn['id']}").status_code == 204
    assert anna.delete(f"{path}/{withdrawn['id']}").status_code == 404
    assert anna.delete(f"{path}/not-an-id").status_code == 404
    assert bert.post("/api/invitations/lookup", json={"token": second}).status_code == 400
    # An expired invitation does not work.
    late_email = f"{unique()}@example.org"
    anna.post(path, json={"email": late_email, "role": "reader"})
    late = invite_token(mailbox, late_email)
    with pool.connection() as conn:
        conn.execute("UPDATE invitations SET expires_at = now() - interval '1 second' WHERE email = %s", (late_email,))
    assert bert.post("/api/invitations/accept", json={"token": late}).status_code == 400
    # A member cannot accept an invitation into his own team twice.
    own_email = f"{unique()}@example.org"
    anna.post(path, json={"email": own_email, "role": "reader"})
    own = invite_token(mailbox, own_email)
    assert anna.post("/api/invitations/lookup", json={"token": own}).json()["memberRole"] == "owner"
    response = anna.post("/api/invitations/accept", json={"token": own})
    assert response.status_code == 409 and response.json()["error"] == "already_member"


def test_invitation_rate_limits(make_app, make_client, quick_user):
    """RATE_LIMIT_INVITE_EMAIL counts by the invited address, and RATE_LIMIT_INVITE_USER by the user who invites. Each
    part shows its key: the same key is refused, while another key still passes."""
    anna, bert, cleo = quick_user(), quick_user(), quick_user()
    path = {who: f"/api/teams/{new_team(who)['handle']}/invitations" for who in (anna, bert, cleo)}
    by_address = make_app(limits={"invite_email": Limit(2, 3600)})
    anna_a, cleo_a = (make_client(by_address, cookies=dict(who.cookies)) for who in (anna, cleo))
    email = f"{unique()}@example.org"
    assert anna_a.post(path[anna], json={"email": email, "role": "reader"}).status_code == 201
    assert anna_a.post(path[anna], json={"email": email, "role": "reader"}).status_code == 201
    response = anna_a.post(path[anna], json={"email": email, "role": "reader"})
    assert response.status_code == 429 and response.json()["error"] == "rate_limited"
    # Another user of another team is refused for the same address, also in capitals. Anna invites another address.
    assert cleo_a.post(path[cleo], json={"email": email.upper(), "role": "reader"}).status_code == 429
    assert anna_a.post(path[anna], json={"email": f"{unique()}@example.org", "role": "reader"}).status_code == 201
    by_user = make_app(limits={"invite_user": Limit(3, 3600)})
    bert_u, cleo_u = (make_client(by_user, cookies=dict(who.cookies)) for who in (bert, cleo))
    second = f"/api/teams/{new_team(bert)['handle']}/invitations"
    for _ in range(3):
        assert bert_u.post(path[bert], json={"email": f"{unique()}@example.org", "role": "reader"}).status_code == 201
    # Bert is refused for a new address in his other team. Cleo still invites.
    response = bert_u.post(second, json={"email": f"{unique()}@example.org", "role": "reader"})
    assert response.status_code == 429 and response.json()["error"] == "rate_limited"
    assert cleo_u.post(path[cleo], json={"email": f"{unique()}@example.org", "role": "reader"}).status_code == 201


def test_team_maps(quick_user, pool, sample_file):
    anna, bert, cleo = quick_user(), quick_user(), quick_user()
    team = new_team(anna)
    add_member(pool, team["handle"], bert, "editor")
    add_member(pool, team["handle"], cleo, "reader")
    created = bert.post("/api/maps", json={"title": "Gemeinsame Map", "team": team["handle"]}).json()
    assert created["owner"] == team["handle"] and created["ownerType"] == "team" and created["role"] == "editor"
    assert created["pageUrl"] == f"{BASE}/{team['handle']}/gemeinsame-map"
    # An editor does not publish: a new map of an editor with a visibility other than private fails.
    response = bert.post("/api/maps", json={"title": "x", "team": team["handle"], "visibility": "public"})
    assert response.status_code == 403 and response.json()["error"] == "forbidden"
    imported = bert.post(f"/api/maps/import?team={team['handle']}", json=sample_file).json()
    assert imported["owner"] == team["handle"] and imported["visibility"] == "private"
    for client, role in ((anna, "owner"), (bert, "editor"), (cleo, "reader")):
        listed = client.get(f"/api/teams/{team['handle']}/maps").json()["maps"]
        assert {m["id"] for m in listed} == {created["id"], imported["id"]}
        assert {m["role"] for m in listed} == {role}
    # Team maps are not in the list of the personal maps.
    assert bert.get("/api/maps").json()["maps"] == []
    assert anna.get("/api/teams").json()["teams"][0]["maps"] == 2
    # The reader reads the private map and its page, but the page cannot write.
    page = cleo.get(f"/{team['handle']}/{imported['slug']}")
    config = server_config(page.text)
    assert config["mode"] == "owner" and config["canWrite"] is False and config["role"] == "reader"
    assert config["api"] == f"/api/maps/{imported['id']}"
    config = server_config(bert.get(f"/{team['handle']}/{imported['slug']}").text)
    assert config["canWrite"] is True and config["role"] == "editor"
    response = bert.post("/api/maps", json={"title": "Gemeinsame Map", "slug": "gemeinsame-map", "team": team["handle"]})
    assert response.status_code == 409 and response.json()["error"] == "slug_taken"


def test_team_map_limit(make_app, make_client, quick_user):
    anna = quick_user()
    team = new_team(anna)
    limited = make_client(make_app(max_maps=1), cookies=dict(anna.cookies))
    assert limited.post("/api/maps", json={"title": "Eins", "team": team["handle"]}).status_code == 201
    response = limited.post("/api/maps", json={"title": "Zwei", "team": team["handle"]})
    assert response.status_code == 409 and response.json()["error"] == "too_many_maps"
    # The limit counts per owner, so the personal maps are separate.
    assert limited.post("/api/maps", json={"title": "Eigene"}).status_code == 201


def test_move_an_own_map_into_a_team(quick_user, pool, sample_file):
    anna, bert, cleo = quick_user(), quick_user(), quick_user()
    team = new_team(anna)
    add_member(pool, team["handle"], bert, "editor")
    add_member(pool, team["handle"], cleo, "reader")
    path = lambda map_id: f"/api/maps/{map_id}/move"  # noqa: E731
    # An owner of the team moves a public map: it arrives private, and its share link stops.
    mine = anna.post("/api/maps/import", json=sample_file).json()
    anna.patch(f"/api/maps/{mine['id']}", json={"visibility": "public"})
    token = anna.post(f"/api/maps/{mine['id']}/shares").json()["token"]
    moved = anna.post(path(mine["id"]), json={"team": team["handle"]}).json()
    assert moved["owner"] == team["handle"] and moved["visibility"] == "private" and moved["slug"] == mine["slug"]
    assert moved["version"] > mine["version"] and moved["role"] == "owner"
    assert anna.get(f"/{team['handle']}/{mine['slug']}").status_code == 200
    assert anna.get(f"/{anna.handle}/{mine['slug']}").status_code == 404
    assert anna.get(f"/api/shared/{token}/docs").status_code == 404
    assert anna.get("/api/maps").json()["maps"] == []
    # An editor moves too, and the map arrives private as well; the slug gets "-2".
    his = bert.post("/api/maps/import", json=sample_file).json()
    bert.patch(f"/api/maps/{his['id']}", json={"visibility": "public"})
    moved = bert.post(path(his["id"]), json={"team": team["handle"]}).json()
    assert moved["visibility"] == "private" and moved["slug"] == mine["slug"] + "-2" and moved["role"] == "editor"
    assert len(bert.get(f"/api/maps/{his['id']}/docs").json()["docs"]) > 0
    # A reader cannot move a map into the team, and nobody moves into a team that is not his.
    hers = cleo.post("/api/maps", json={"title": "Leserin"}).json()
    response = cleo.post(path(hers["id"]), json={"team": team["handle"]})
    assert response.status_code == 403 and response.json()["error"] == "forbidden"
    stranger = quick_user()
    other = stranger.post("/api/maps", json={"title": "Fremd"}).json()
    assert stranger.post(path(other["id"]), json={"team": team["handle"]}).status_code == 404
    assert anna.post(path(other["id"]), json={"team": team["handle"]}).status_code == 404
    assert cleo.post(path(hers["id"]), json={"team": "nobody-here"}).status_code == 404


@pytest.mark.parametrize("role", ["owner", "editor"])
def test_a_moved_map_always_arrives_private(quick_user, make_client, pool, sample_file, role):
    """His decision of 2026-10-19, "Always arrive private": every move of a personal map into a team makes the map
    private, with embedding off, also for a team owner. Its public addresses and its share links stop working, also
    when an owner of the team later shares the map again."""
    anna = quick_user()
    team = new_team(anna)
    mover = anna if role == "owner" else quick_user()
    if role == "editor":
        add_member(pool, team["handle"], mover, "editor")
    mine = mover.post("/api/maps/import", json=sample_file).json()
    mover.patch(f"/api/maps/{mine['id']}", json={"visibility": "public",
                                                 "embed": {"allow": "origins", "origins": ["https://cv.example.org"]}})
    token = mover.post(f"/api/maps/{mine['id']}/shares").json()["token"]
    moved = mover.post(f"/api/maps/{mine['id']}/move", json={"team": team["handle"]}).json()
    assert moved["visibility"] == "private" and moved["role"] == role
    assert moved["embed"] == {"allow": "origins", "origins": [], "url": None}
    reader = make_client()
    for address in (f"/{team['handle']}/{mine['slug']}", f"/api/public/{team['handle']}/{mine['slug']}/docs",
                    f"/e/{team['handle']}/{mine['slug']}", f"/s/{token}", f"/api/shared/{token}/docs", f"/e/s/{token}"):
        assert reader.get(address).status_code == 404, address
    assert mover.get(f"/{team['handle']}/{mine['slug']}").status_code == 200
    assert anna.get(f"/api/maps/{mine['id']}/shares").json() == {"visibility": "private", "shares": []}
    # When an owner of the team shares the map by link again, the old link stays dead; a new link works.
    anna.patch(f"/api/maps/{mine['id']}", json={"visibility": "link"})
    assert reader.get(f"/api/shared/{token}/docs").status_code == 404
    fresh = anna.post(f"/api/maps/{mine['id']}/shares").json()["token"]
    assert reader.get(f"/api/shared/{fresh}/docs").status_code == 200


def test_public_team_map_by_path_and_subdomain(quick_user, make_client, sample_file):
    anna = quick_user()
    team = new_team(anna, name="Öffentliches Team")
    created = anna.post(f"/api/maps/import?team={team['handle']}", json=sample_file).json()
    reader = make_client()
    assert reader.get(f"/{team['handle']}/{created['slug']}").status_code == 404
    published = anna.patch(f"/api/maps/{created['id']}", json={"visibility": "public"}).json()
    assert published["subdomainUrl"] == f"https://{team['handle']}.it-skills.test/{created['slug']}"
    page = reader.get(f"/{team['handle']}/{created['slug']}")
    assert page.status_code == 200
    assert server_config(page.text)["mode"] == "public"
    listing = reader.get(f"/{team['handle']}")
    assert listing.status_code == 200 and "Öffentliches Team" in listing.text
    assert f'href="/{team["handle"]}/{created["slug"]}"' in listing.text
    host = {"Host": f"{team['handle']}.it-skills.test"}
    assert reader.get(f"/{created['slug']}", headers=host).status_code == 200
    assert f'href="/{created["slug"]}"' in reader.get("/", headers=host).text
    assert [m["slug"] for m in reader.get(f"/api/public/{team['handle']}").json()["maps"]] == [created["slug"]]


def test_account_delete_and_teams(quick_user, pool):
    anna, bert = quick_user(), quick_user()
    shared = new_team(anna)
    alone = new_team(anna)
    anna.post("/api/maps", json={"title": "Map allein", "team": alone["handle"]})
    add_member(pool, shared["handle"], bert, "reader")
    response = anna.post("/api/account/delete", json={"password": PASSWORD})
    assert response.status_code == 409 and response.json()["error"] == "last_owner"
    assert shared["handle"] in response.json()["message"]
    assert anna.get("/api/account").status_code == 200
    anna.patch(f"/api/teams/{shared['handle']}/members/{bert.handle}", json={"role": "owner"})
    assert anna.post("/api/account/delete", json={"password": PASSWORD}).status_code == 204
    # The team in which Anna was alone went with her account, with its map; the other team stays.
    assert count_rows(pool, "owners", "handle = %s", (alone["handle"],)) == 0
    assert count_rows(pool, "maps") == 0
    view = bert.get(f"/api/teams/{shared['handle']}").json()
    assert [(m["handle"], m["role"]) for m in view["members"]] == [(bert.handle, "owner")]


@pytest.mark.parametrize("reader", [False, True], ids=["two-owners", "two-owners-and-a-reader"])
def test_two_owners_delete_their_accounts_at_the_same_moment(quick_user, pool, database, reader):
    """Both owners of a team delete their accounts at once. An outside lock on their two user rows holds each delete
    after its check of the teams and before its commit, so that both checks run before either delete is done. The
    team never stays without members, and a team with a third member keeps an owner. (The lock is on the user rows,
    because each delete locks its owner row first, before the check of the teams: store.lock_owner.)"""
    anna, bert = quick_user(), quick_user()
    team = new_team(anna)
    add_member(pool, team["handle"], bert, "owner")
    anna.post("/api/maps", json={"title": "Öffentlich", "team": team["handle"], "visibility": "public"})
    if reader:
        add_member(pool, team["handle"], quick_user(), "reader")
    with psycopg.connect(database) as hold:
        hold.execute("SELECT id FROM users WHERE id = ANY(%s) FOR UPDATE", ([anna.user_id, bert.user_id],))
        calls = [Background(lambda c=c: c.post("/api/account/delete", json={"password": PASSWORD})) for c in (anna, bert)]
        wait_for_locks(pool, 2)
        hold.rollback()
    answers = [call.result() for call in calls]
    assert count_rows(pool, "organizations o", "NOT EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id = o.id)") == 0
    if reader:
        # The second delete finds itself the last owner of a team with a member, so it stops.
        assert sorted(a.status_code for a in answers) == [204, 409]
        assert next(a for a in answers if a.status_code == 409).json()["error"] == "last_owner"
        assert count_rows(pool, "memberships", "role = 'owner'") == 1
        assert count_rows(pool, "maps") == 1
    else:
        # The second delete finds itself the only member, so the team and its map go with its account.
        assert [a.status_code for a in answers] == [204, 204]
        assert count_rows(pool, "organizations") == 0 and count_rows(pool, "maps") == 0


def test_account_page_has_the_teams_section(client):
    page = client.get("/account").text
    assert 'id="teams"' in page and "Teams" in page and "Karte" not in page
    script = client.get("/account/account.js").text
    assert "/api/teams" in script and "/api/invitations/accept" in script


def test_invitation_mail_names_team_role_and_link(quick_user, mailbox):
    # Anna writes German, and the address has no account, so the invitation is German.
    anna = quick_user(language="de")
    team = new_team(anna, name="Team West")
    email = f"{unique()}@example.org"
    anna.post(f"/api/teams/{team['handle']}/invitations", json={"email": email, "role": "reader"})
    mail = mailbox.wait(email, "Einladung")
    assert "Team West" in mail["Subject"]
    text = mail["Text"]
    assert anna.handle in text and team["handle"] in text and "Rolle Leser" in text and "7 Tage" in text
    assert f"{BASE}/account#invite=" in text


HIDDEN_NAMES = ("Team Nord", "Team Nord", "Team​Nord", "Team­Nord", "Team\u0085Nord", "Team\x07Nord",
                "‮Team Nord", "Team﻿Nord")


def test_team_names_refuse_line_breaks_and_invisible_characters(quick_user):
    """A team name goes into the subject of every invitation mail. A line separator there dropped the mail, so a name
    refuses the Unicode categories Cc, Cf, Zl and Zp: control and format characters, and line and paragraph separators."""
    anna = quick_user()
    team = new_team(anna)
    for name in HIDDEN_NAMES:
        response = anna.post("/api/teams", json={"name": name, "handle": unique("t")})
        assert response.status_code == 400 and response.json()["error"] == "invalid_name", repr(name)
        response = anna.patch(f"/api/teams/{team['handle']}", json={"name": name})
        assert response.status_code == 400 and response.json()["error"] == "invalid_name", repr(name)
    for name in ("Team Süd", "Équipe 😀", "Команда"):
        assert new_team(anna, name=name)["name"] == name


def test_a_mail_subject_never_breaks_the_mail(quick_user, pool, mailbox, app):
    """A team from before the check of names can still hold a line separator. Its invitation mail arrives anyway,
    because the subject of a mail holds every such character as a space."""
    anna = quick_user()
    team = new_team(anna)
    with pool.connection() as conn:
        conn.execute("UPDATE organizations SET name = %s WHERE id = (SELECT id FROM owners WHERE handle = %s)",
                     ("Team Nord", team["handle"]))
    email = f"{unique()}@example.org"
    assert anna.post(f"/api/teams/{team['handle']}/invitations", json={"email": email, "role": "reader"}).status_code == 201
    mail = mailbox.wait(email, SUBJECTS["invitation"])
    assert "Team Nord" in mail["Subject"] and " " not in mail["Subject"]
    from app.mail import build_message

    message = build_message(app.state.settings, "a@example.org", "Team Nord\r\nBcc: b@example.org​", "Text")
    assert message["Subject"] == "Team Nord Bcc: b@example.org" and message["Bcc"] is None


def test_the_database_keeps_the_roles(pool, quick_user):
    anna = quick_user()
    team = new_team(anna)
    with pool.connection() as conn, pytest.raises(Exception, match="memberships_role_check"):
        conn.execute("UPDATE memberships SET role = 'admin' WHERE user_id = %s", (anna.user_id,))
