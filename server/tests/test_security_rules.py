"""Security rules that had no test of their own: the CSRF check on PUT, PATCH and DELETE, an expired session, an expired
token and a token of the wrong purpose, and the login limit of an address on the password change, the account delete
and the team delete."""
from __future__ import annotations

from conftest import BASE, PASSWORD, unique

from app.config import Limit
from app.security import hash_token, new_token

# Each header set lacks the CSRF header, has a foreign Origin, or has no Origin.
CSRF_CASES = [
    {},
    {"Origin": BASE},
    {"X-Requested-With": "it-skills"},
    {"X-Requested-With": "it-skills", "Origin": "https://evil.example"},
    {"X-Requested-With": "XMLHttpRequest", "Origin": BASE},
    {"X-Requested-With": "it-skills", "Origin": "null"},
]


def token_for(pool, user_id, purpose: str, minutes: int) -> str:
    """A token of the mail of a purpose, written straight into the database. A negative minutes makes it expired."""
    token = new_token()
    with pool.connection() as conn:
        conn.execute("INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at)"
                     " VALUES (%s, %s, %s, now() + make_interval(mins => %s))",
                     (hash_token(token), user_id, purpose, minutes))
    return token


def login(client, email, password=PASSWORD):
    return client.post("/api/auth/login", json={"email": email, "password": password})


def test_csrf_on_put_patch_and_delete(quick_user, make_client):
    """A write with PUT, PATCH or DELETE without the CSRF header or with a foreign Origin is refused as a POST is, and
    changes nothing."""
    anna = quick_user()
    team = unique("t")
    assert anna.post("/api/teams", json={"name": "Team", "handle": team}).status_code == 201
    bert = quick_user()
    with_bert = anna.post(f"/api/teams/{team}/invitations", json={"email": bert.email, "role": "reader"}).json()
    map_id = anna.post("/api/maps", json={"title": "Karte"}).json()["id"]
    share = anna.post(f"/api/maps/{map_id}/shares").json()
    raw = make_client(headers={}, cookies={"__Host-session": anna.cookies.get("__Host-session")})
    writes = [
        ("PUT", f"/api/maps/{map_id}/docs/skills/python", {"name": "Python"}),
        ("PATCH", f"/api/maps/{map_id}", {"title": "Fremd"}),
        ("PATCH", "/api/account", {"language": "de"}),
        ("PATCH", f"/api/teams/{team}", {"name": "Fremd"}),
        ("DELETE", f"/api/maps/{map_id}/docs/skills/python", None),
        ("DELETE", f"/api/maps/{map_id}/shares/{share['id']}", None),
        ("DELETE", f"/api/teams/{team}/invitations/{with_bert['invitation']['id']}", None),
        ("DELETE", f"/api/maps/{map_id}", None),
    ]
    for headers in CSRF_CASES:
        for method, path, body in writes:
            response = raw.request(method, path, json=body, headers=headers)
            assert response.status_code == 403 and response.json()["error"] == "csrf", (method, path, headers)
    # Nothing changed.
    assert anna.get(f"/api/maps/{map_id}").json()["title"] == "Karte"
    assert anna.get(f"/api/maps/{map_id}/docs").json()["docs"] == []
    assert anna.get("/api/account").json()["language"] == "en"
    assert anna.get(f"/api/teams/{team}").json()["name"] == "Team"
    assert [s["id"] for s in anna.get(f"/api/maps/{map_id}/shares").json()["shares"]] == [share["id"]]
    assert len(anna.get(f"/api/teams/{team}/invitations").json()["invitations"]) == 1
    # The same writes with the CSRF header and the right Origin work.
    assert anna.put(f"/api/maps/{map_id}/docs/skills/python", json={"name": "Python"}).status_code == 200
    assert anna.patch(f"/api/maps/{map_id}", json={"title": "Neu"}).status_code == 200
    assert anna.delete(f"/api/maps/{map_id}").status_code == 204


def test_an_expired_session_gets_no_access(quick_user, pool):
    anna = quick_user()
    map_id = anna.post("/api/maps", json={"title": "Karte"}).json()["id"]
    token = anna.cookies.get("__Host-session")
    with pool.connection() as conn:
        conn.execute("UPDATE sessions SET expires_at = now() - interval '1 second', last_seen_at = now() - interval"
                     " '31 days' WHERE id_hash = %s", (hash_token(token),))
    response = anna.get("/api/account")
    assert response.status_code == 401 and response.json()["error"] == "not_logged_in"
    # The cookie does not slide the session back to life.
    assert "set-cookie" not in response.headers
    assert anna.get("/api/auth/session").json() == {"signedIn": False}
    assert anna.get(f"/api/maps/{map_id}").status_code == 404
    assert anna.put(f"/api/maps/{map_id}/docs/skills/python", json={"name": "Python"}).status_code == 401
    assert anna.post("/api/maps", json={"title": "Noch eine"}).status_code == 401
    with pool.connection() as conn:
        row = conn.execute("SELECT expires_at < now() AS ended FROM sessions WHERE id_hash = %s",
                           (hash_token(token),)).fetchone()
    assert row["ended"]


def test_an_expired_token_does_nothing(client, quick_user, pool):
    # An expired confirmation link confirms nothing.
    email = f"{unique()}@example.org"
    assert client.post("/api/auth/register", json={"email": email, "password": PASSWORD,
                                                    "handle": unique()}).status_code == 202
    with pool.connection() as conn:
        user_id = conn.execute("SELECT id FROM users WHERE email = %s", (email,)).fetchone()["id"]
    late = token_for(pool, user_id, "confirm", -1)
    response = client.post("/api/auth/confirm", json={"token": late, "password": PASSWORD})
    assert response.status_code == 400 and response.json()["error"] == "invalid_token"
    assert login(client, email).json()["error"] == "not_confirmed"
    # An expired reset link sets no password.
    anna = quick_user()
    late = token_for(pool, anna.user_id, "reset", -1)
    response = client.post("/api/auth/reset", json={"token": late, "password": "ein neues langes Passwort"})
    assert response.status_code == 400 and response.json()["error"] == "invalid_token"
    assert login(client, anna.email).status_code == 200


def test_a_token_works_only_for_its_purpose(client, quick_user, pool):
    """A confirmation token cannot set a password, and a reset token cannot confirm an account. A wrong use leaves
    each token valid for its own purpose."""
    anna = quick_user()
    confirm_token = token_for(pool, anna.user_id, "confirm", 60)
    reset_token = token_for(pool, anna.user_id, "reset", 60)
    response = client.post("/api/auth/reset", json={"token": confirm_token, "password": "ein neues langes Passwort"})
    assert response.status_code == 400 and response.json()["error"] == "invalid_token"
    assert login(client, anna.email).status_code == 200
    response = client.post("/api/auth/confirm", json={"token": reset_token, "password": PASSWORD})
    assert response.status_code == 400 and response.json()["error"] == "invalid_token"
    # An account that nobody confirmed: its reset token does not confirm it.
    email = f"{unique()}@example.org"
    client.post("/api/auth/register", json={"email": email, "password": PASSWORD, "handle": unique()})
    with pool.connection() as conn:
        user_id = conn.execute("SELECT id FROM users WHERE email = %s", (email,)).fetchone()["id"]
    wrong = token_for(pool, user_id, "reset", 60)
    response = client.post("/api/auth/confirm", json={"token": wrong, "password": PASSWORD})
    assert response.status_code == 400 and response.json()["error"] == "invalid_token"
    assert login(client, email).json()["error"] == "not_confirmed"
    # Each token still works for its own purpose.
    assert client.post("/api/auth/reset", json={"token": reset_token, "password": "ein neues langes Passwort"}
                       ).status_code == 200
    assert client.post("/api/auth/confirm", json={"token": token_for(pool, user_id, "confirm", 60),
                                                  "password": PASSWORD}).status_code == 200


def test_the_login_limit_of_the_address_counts_password_changes_and_deletes(make_app, make_client, quick_user):
    """RATE_LIMIT_LOGIN_ACCOUNT counts each check of the password of an address: a login, a password change, an account
    delete and a team delete. At the limit, even the right password is refused, and nothing changes."""
    app = make_app(limits={"login_account": Limit(2, 3600)})

    def on_app(user):
        return make_client(app, cookies={"__Host-session": user.cookies.get("__Host-session")})

    anna_user = quick_user()
    anna = on_app(anna_user)
    for _ in range(2):
        response = anna.post("/api/account/password", json={"current": "falsch falsch falsch", "new": "x" * 20})
        assert response.status_code == 401 and response.json()["error"] == "wrong_password"
    response = anna.post("/api/account/password", json={"current": PASSWORD, "new": "ein neues langes Passwort"})
    assert response.status_code == 429 and response.json()["error"] == "rate_limited"
    assert "retry-after" in response.headers

    bert_user = quick_user()
    bert = on_app(bert_user)
    for _ in range(2):
        assert bert.post("/api/account/delete", json={"password": "falsch falsch falsch"}).status_code == 401
    response = bert.post("/api/account/delete", json={"password": PASSWORD})
    assert response.status_code == 429 and response.json()["error"] == "rate_limited"
    assert bert.get("/api/account").status_code == 200

    # The bucket is the one of the login: two failed logins of an address stop its password change, its account
    # delete and its team delete.
    carla_user = quick_user()
    carla = on_app(carla_user)
    team = unique("t")
    assert carla.post("/api/teams", json={"name": "Team", "handle": team}).status_code == 201
    for _ in range(2):
        assert login(make_client(app), carla_user.email, "ein falsches Passwort").status_code == 401
    assert carla.post("/api/account/password", json={"current": PASSWORD, "new": "ein neues langes Passwort"}
                      ).status_code == 429
    assert carla.post("/api/account/delete", json={"password": PASSWORD}).status_code == 429
    assert carla.post(f"/api/teams/{team}/delete", json={"password": PASSWORD}).status_code == 429
    assert carla.get(f"/api/teams/{team}").status_code == 200
    # Nothing changed: each password still signs in, through an app without the low limit.
    for user in (anna_user, bert_user, carla_user):
        assert login(make_client(), user.email).status_code == 200
