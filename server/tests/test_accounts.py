"""Registration with double opt-in, login, sessions, password reset and change, rate limits, delete."""
from __future__ import annotations

import ipaddress
import io
import json
import re
import zipfile
from datetime import timedelta

import pytest
from conftest import BASE, PASSWORD, SUBJECTS, count_rows, unique

from app.config import Limit, Settings
from app.security import PASSWORD_MIN, client_ip, hash_token


def register(client, email, handle, password=PASSWORD):
    return client.post("/api/auth/register", json={"email": email, "password": password, "handle": handle})


def login(client, email, password=PASSWORD):
    return client.post("/api/auth/login", json={"email": email, "password": password})


def confirm(client, token, password=PASSWORD):
    return client.post("/api/auth/confirm", json={"token": token, "password": password})


def max_age(cookie: str) -> int:
    return int(re.search(r"max-age=(\d+)", cookie, re.IGNORECASE)[1])


def change_session(pool, token: str, assignments: str) -> None:
    """Sets columns of the session of a token, for example "last_seen_at = now() - interval '2 hours'"."""
    with pool.connection() as conn:
        conn.execute(f"UPDATE sessions SET {assignments} WHERE id_hash = %s", (hash_token(token),))


def session_row(pool, token: str) -> dict:
    with pool.connection() as conn:
        return conn.execute(
            "SELECT expires_at - created_at AS life, last_seen_at > now() - interval '1 minute' AS just_seen"
            " FROM sessions WHERE id_hash = %s", (hash_token(token),)).fetchone()


def test_register_confirm_and_login(client, mailbox):
    handle = unique()
    email = f"{handle}@example.org"
    response = register(client, email, handle)
    assert response.status_code == 202
    assert response.json()["status"] == "check_mail"
    # Before the link in the mail, the account does not work.
    response = login(client, email)
    assert response.status_code == 403 and response.json()["error"] == "not_confirmed"
    token = mailbox.token(email, "confirm")
    assert confirm(client, token).status_code == 200
    assert client.get("/api/auth/session").json() == {"signedIn": False}
    assert client.get("/api/account").status_code == 401
    response = login(client, email)
    assert response.status_code == 200
    assert response.json() == {"handle": handle, "email": email, "language": "en"}
    assert client.get("/api/auth/session").json() == {"signedIn": True, "handle": handle, "email": email,
                                                       "language": "en"}
    account = client.get("/api/account").json()
    assert account["handle"] == handle and account["email"] == email and account["maps"] == 0
    assert account["profileUrl"] == f"{BASE}/{handle}"
    assert account["siteUrl"] == f"https://{handle}.it-skills.test"


def test_confirm_link_works_once(client, mailbox):
    handle = unique()
    email = f"{handle}@example.org"
    register(client, email, handle)
    token = mailbox.token(email, "confirm")
    assert confirm(client, token).status_code == 200
    response = confirm(client, token)
    assert response.status_code == 400 and response.json()["error"] == "invalid_token"
    assert confirm(client, "made-up").status_code == 400


def test_confirm_needs_the_password_of_the_registration(client, mailbox):
    handle = unique()
    email = f"{handle}@example.org"
    register(client, email, handle)
    token = mailbox.token(email, "confirm")
    # The link alone confirms nothing: the confirm step asks for the password of the registration.
    response = client.post("/api/auth/confirm", json={"token": token})
    assert response.status_code == 422 and response.json()["error"] == "invalid_request"
    response = confirm(client, token, "ein ganz anderes Passwort")
    assert response.status_code == 401 and response.json()["error"] == "wrong_password"
    assert login(client, email).status_code == 403
    # A wrong password leaves the link valid.
    assert confirm(client, token).status_code == 200
    assert login(client, email).status_code == 200


def test_a_second_registration_cannot_take_over_an_unconfirmed_address(client, make_client, mailbox, pool):
    """Somebody registers the address of another person before that person confirms it. Only somebody with both the
    mailbox and the password of a registration confirms it, so the address stays free for the person who owns it."""
    email = f"{unique()}@example.org"
    owner_password, other_password = "das Passwort der Besitzerin", "das Passwort eines Fremden"
    assert register(client, email, unique(), owner_password).status_code == 202
    first = mailbox.token(email, "confirm")
    stranger = make_client()
    assert register(stranger, email, unique(), other_password).status_code == 202
    second = mailbox.token(email, "confirm", count=2)
    # The second registration replaced the first one, so the first link is gone, and the newest link does not take the
    # password of the owner of the mailbox. The stranger has no link at all.
    assert confirm(client, first, owner_password).json()["error"] == "invalid_token"
    assert confirm(client, second, owner_password).json()["error"] == "wrong_password"
    assert login(stranger, email, other_password).json()["error"] == "not_confirmed"
    # The owner of the mailbox registers again, confirms with her own password and signs in; the stranger cannot.
    assert register(client, email, unique(), owner_password).status_code == 202
    third = mailbox.token(email, "confirm", count=3)
    assert confirm(client, third, owner_password).status_code == 200
    assert login(client, email, owner_password).status_code == 200
    assert login(stranger, email, other_password).status_code == 401
    assert count_rows(pool, "users") == 1


def test_session_cookie_flags(client, signup, make_app, make_client, mailbox):
    account = signup(client)
    response = login(client, account["email"])
    cookie = response.headers["set-cookie"]
    assert cookie.startswith("__Host-session=")
    lowered = cookie.lower()
    assert "httponly" in lowered and "secure" in lowered and "samesite=lax" in lowered and "path=/" in lowered
    assert "domain=" not in lowered
    # Only APP_ENV=local turns Secure off; then the cookie cannot carry the __Host- prefix.
    local = make_client(make_app(local=True))
    response = login(local, account["email"])
    cookie = response.headers["set-cookie"]
    assert cookie.startswith("session=") and "secure" not in cookie.lower()


def test_new_session_id_at_login(client, signup, make_client):
    account = signup(client)
    first = client.cookies.get("__Host-session")
    assert login(client, account["email"]).status_code == 200
    second = client.cookies.get("__Host-session")
    assert first and second and first != second
    assert client.get("/api/account").status_code == 200
    stale = make_client(cookies={"__Host-session": first})
    assert stale.get("/api/account").status_code == 401


def test_the_cookie_ends_with_the_fixed_end_of_the_session(client, signup, pool):
    """The cookie of a session ends at the fixed end of the session, SESSION_DAYS after the sign-in: its Max-Age is the
    whole seconds that are left until then, so the browser never keeps it longer than the server keeps the session. A
    use moves only the idle end on the server, so no later answer sets the cookie again. An answer that sets the cookie
    itself keeps its own: a new session after a change of the password, and the cleared cookie after a delete."""
    account = signup(client)
    cookies = login(client, account["email"]).headers.get_list("set-cookie")
    token = client.cookies.get("__Host-session")
    assert len(cookies) == 1 and cookies[0].startswith(f"__Host-session={token};")
    assert 30 * 86400 - 60 < max_age(cookies[0]) < 30 * 86400, cookies[0]
    assert "httponly" in cookies[0].lower()
    change_session(pool, token, "last_seen_at = now() - interval '2 hours'")
    for path in ("/api/account", "/api/auth/session", "/"):
        response = client.get(path)
        assert response.status_code == 200 and "set-cookie" not in response.headers, (path, response.headers)
    assert session_row(pool, token)["just_seen"]
    response = client.post("/api/account/password", json={"current": PASSWORD, "new": "ein neues langes Passwort"})
    cookies = response.headers.get_list("set-cookie")
    assert len(cookies) == 1 and not cookies[0].startswith(f"__Host-session={token};")
    assert 30 * 86400 - 60 < max_age(cookies[0]) < 30 * 86400, cookies[0]
    change_session(pool, client.cookies.get("__Host-session"), "last_seen_at = now() - interval '2 hours'")
    response = client.post("/api/account/delete", json={"password": "ein neues langes Passwort"})
    cookies = response.headers.get_list("set-cookie")
    assert response.status_code == 204 and len(cookies) == 1 and "max-age=0" in cookies[0].lower()


def test_a_session_ends_thirty_days_after_the_sign_in_also_in_daily_use(quick_user, pool):
    """The fixed end (selfhost/STUDY.md): a session ends SESSION_DAYS after the sign-in, also when it is used every day.
    A use moves only the idle end. The time of the sign-in decides too, so a session whose end moved forward, as with the
    code before this rule, ends as well."""
    anna = quick_user()
    token = anna.cookies.get("__Host-session")
    # Signed in 29 days and 23 hours ago and used two hours ago: one hour is left.
    change_session(pool, token, "created_at = now() - interval '29 days 23 hours', expires_at = now() + interval"
                                " '1 hour', last_seen_at = now() - interval '2 hours'")
    assert anna.get("/api/account").status_code == 200
    row = session_row(pool, token)
    assert row["just_seen"] and row["life"] == timedelta(days=30), row
    change_session(pool, token, "created_at = now() - interval '30 days 1 minute', expires_at = now() - interval"
                                " '1 minute', last_seen_at = now()")
    response = anna.get("/api/account")
    assert response.status_code == 401 and response.json()["error"] == "not_logged_in"
    change_session(pool, token, "created_at = now() - interval '31 days', expires_at = now() + interval '20 days',"
                                " last_seen_at = now()")
    assert anna.get("/api/account").status_code == 401
    assert anna.get("/api/auth/session").json() == {"signedIn": False}


def test_a_session_ends_seven_days_after_its_last_use(quick_user, pool, make_app, make_client):
    """The idle end (selfhost/STUDY.md): a session ends SESSION_IDLE_DAYS after its last use, 7 by default, before its
    fixed end."""
    anna = quick_user()
    token = anna.cookies.get("__Host-session")
    change_session(pool, token, "expires_at = now() + interval '20 days', last_seen_at = now() - interval"
                                " '6 days 23 hours'")
    assert anna.get("/api/account").status_code == 200
    assert session_row(pool, token)["just_seen"]
    change_session(pool, token, "last_seen_at = now() - interval '7 days 1 minute'")
    response = anna.get("/api/account")
    assert response.status_code == 401 and response.json()["error"] == "not_logged_in"
    assert anna.get("/api/auth/session").json() == {"signedIn": False}
    # SESSION_IDLE_DAYS sets the idle end.
    change_session(pool, token, "last_seen_at = now() - interval '3 days'")
    short = make_client(make_app(session_idle_days=2), cookies={"__Host-session": token})
    assert short.get("/api/account").status_code == 401
    assert anna.get("/api/account").status_code == 200


def test_session_settings():
    settings = Settings.from_env({"BASE_URL": BASE})
    assert (settings.session_days, settings.session_idle_days) == (30, 7)
    settings = Settings.from_env({"BASE_URL": BASE, "SESSION_DAYS": "10", "SESSION_IDLE_DAYS": "2"})
    assert (settings.session_days, settings.session_idle_days) == (10, 2)
    for name in ("SESSION_DAYS", "SESSION_IDLE_DAYS"):
        with pytest.raises(ValueError, match="SESSION_DAYS and SESSION_IDLE_DAYS"):
            Settings.from_env({"BASE_URL": BASE, name: "0"})


def test_wrong_password_and_unknown_email_get_the_same_answer(client, signup, make_client):
    account = signup(make_client())
    wrong = login(client, account["email"], "ein ganz falsches Passwort")
    unknown = login(client, "niemand-" + account["email"], "ein ganz falsches Passwort")
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json() == {"error": "invalid_credentials",
                                              "message": "The e-mail address or the password is wrong.", "params": {}}
    assert "set-cookie" not in wrong.headers


def test_register_with_a_known_email_says_nothing(client, signup, make_client, mailbox, pool):
    account = signup(make_client())
    response = register(client, account["email"], unique())
    assert response.status_code == 202 and response.json()["status"] == "check_mail"
    assert mailbox.wait(account["email"], SUBJECTS["registered"])
    assert count_rows(pool, "users") == 1


def test_unconfirmed_registration_can_be_repeated(client, mailbox, pool):
    # A new registration replaces an unconfirmed one: its handle and its password. The newest link confirms it only with
    # the password of the newest registration.
    email = f"{unique()}@example.org"
    first_password, second_password = "das erste lange Passwort", "das zweite lange Passwort"
    register(client, email, unique(), first_password)
    handle = unique()
    assert register(client, email, handle, second_password).status_code == 202
    token = mailbox.token(email, "confirm", count=2)
    response = confirm(client, token, first_password)
    assert response.status_code == 401 and response.json()["error"] == "wrong_password"
    assert confirm(client, token, second_password).status_code == 200
    assert login(client, email, second_password).json()["handle"] == handle
    assert login(client, email, first_password).status_code == 401
    assert count_rows(pool, "users") == 1


VERSE = ("Am Anfang schuf Gott Himmel und Erde. Und die Erde war wüst und leer, und es war finster auf der Tiefe; "
         "und der Geist Gottes schwebte auf dem Wasser")


def test_password_rules(client):
    """At least 12 characters, at least 4 different characters, not the e-mail address or the handle, and the top score
    of zxcvbn with its English lists and the German lists. Symbols, digits and capitals are free, and a long sentence
    is welcome up to 1024 characters."""
    email, handle = f"{unique()}@example.org", unique("handle-")  # 17 characters: a shorter one fails as short before personal
    short = "a1b2c3d4e5!"  # one below the minimum
    assert len(short) == PASSWORD_MIN - 1 == 11
    refused = {short: "short", (VERSE * 9)[:1025]: "long", email: "personal", handle: "personal",
               "aaaaaaaaaaa!": "guessable", "a!!ba!b!aab!": "guessable", "123456789012": "guessable",
               "123456789012!": "guessable", "myPassword1!": "guessable", "Password123!": "guessable",
               "!@#$%^&*()_+": "guessable", "Sommer2026!!": "guessable", "Ichliebedich1": "guessable",
               "Frühling2026!": "guessable", "it-skills2026": "guessable", handle + "2026!": "guessable"}
    for password, variant in refused.items():
        response = register(client, email, handle, password)
        assert response.status_code == 400, password
        assert response.json()["error"] == "weak_password" and response.json()["params"]["variant"] == variant, password
    allowed = ["Kaffeetasse Laterne Wolke", "korrekt Pferd Batterie 7", "#]!%(+@;^?<~", "zwölf Zeichen 🙂",
               "Добрый день, мир", "„Guten Morgen“ sagte sie", VERSE, (VERSE * 9)[:1024]]
    for password in allowed:
        assert register(client, f"{unique()}@example.org", unique(), password).status_code == 202, password


def test_password_check_gives_the_verdict_of_the_rule(client, signup, make_client):
    """POST /api/auth/password-check applies the rule of a new password and stores nothing: the strength meter of the
    account page shows its answer. The personal words come from the body, or else from the signed-in user."""
    def check(c, password, **body):
        response = c.post("/api/auth/password-check", json={"password": password, **body})
        assert response.status_code == 200, response.text
        return response.json()

    weak = check(client, "123456789012!")
    assert weak["ok"] is False and weak["problem"] == "guessable" and weak["score"] < 4
    assert weak["warning"] == "similar" and weak["tips"][0] == "moreWords"
    assert check(client, "!@#$%^&*()_+")["warning"] == "keyboard"
    assert check(client, "aaaaaaaaaaa!") == {"ok": False, "problem": "guessable", "score": 0, "warning": "repeat",
                                             "tips": ["moreWords"], "min": 12, "max": 1024}
    assert check(client, "kurz")["problem"] == "short" and check(client, VERSE * 9)["problem"] == "long"
    strong = check(client, "Kaffeetasse Laterne Wolke")
    assert strong == {"ok": True, "problem": None, "score": 4, "warning": None, "tips": [], "min": 12, "max": 1024}
    # The same rule as the registration: a password that contains the handle of the form.
    handle = unique("zq")
    assert check(client, handle + "!", handle=handle)["warning"] == "personal"
    assert check(client, f"{handle}@example.org", email=f"{handle}@example.org")["problem"] == "personal"
    # Without personal words in the body, the account of the session counts.
    signed_in = make_client()
    signup(signed_in, handle=handle)
    assert check(signed_in, handle + "!")["warning"] == "personal"
    assert check(make_client(), handle + "!")["warning"] != "personal"


def test_parallel_password_checks_keep_their_own_personal_words(make_client):
    """zxcvbn keeps the personal words of a call in its module, so the server runs one rating at a time. Many parallel
    checks with other personal words each get the answer of their own words."""
    from concurrent.futures import ThreadPoolExecutor

    first, second = unique("zq"), unique("zx")

    def warning(own: str, other: str) -> str | None:
        client = make_client()
        response = client.post("/api/auth/password-check", json={"password": own + "!", "handle": other})
        return response.json()["warning"]

    with ThreadPoolExecutor(8) as pool:
        mixed = list(pool.map(lambda i: warning(first, first) if i % 2 else warning(first, second), range(40)))
    assert mixed[1::2] == ["personal"] * 20
    assert "personal" not in mixed[0::2]


def test_handle_rules(client, signup, make_client):
    for handle in ("an na", "an", "-anna", "anna-", "an--na", "a" * 31, "anna_b", "änna", "anna.b"):
        response = register(client, f"{unique()}@example.org", handle)
        assert response.status_code == 400 and response.json()["error"] == "invalid_handle", handle
    for handle in ("www", "api", "app", "mail", "admin", "static", "assets", "embed", "konto"):
        response = register(client, f"{unique()}@example.org", handle)
        assert response.status_code == 400 and response.json()["error"] == "reserved_handle", handle
    account = signup(make_client())
    response = register(client, f"{unique()}@example.org", account["handle"])
    assert response.status_code == 409 and response.json()["error"] == "handle_taken"
    assert register(client, f"{unique()}@example.org", "a" * 30).status_code == 202
    # Capitals are taken as lowercase letters.
    assert register(client, f"{unique()}@example.org", "Anna-B").status_code == 202
    response = register(client, f"{unique()}@example.org", "anna-b")
    assert response.status_code == 409 and response.json()["error"] == "handle_taken"


def test_invalid_email(client):
    for email in ("", "anna", "anna@", "@example.org", "anna@example", "an na@example.org"):
        response = register(client, email, unique())
        assert response.status_code == 400 and response.json()["error"] == "invalid_email", email


def test_email_refuses_characters_that_split_or_quote_an_address(client, quick_user):
    """A mail header reads a comma or a semicolon as the end of an address, and <, >, (, ), [, ], \\ and " as quotes or
    comments, so "postmaster,x@example.org" could reach two mailboxes. An address with one of them is refused, at a
    registration and at an invitation, and so is an address with a control character."""
    anna = quick_user()
    team = anna.post("/api/teams", json={"name": "Team", "handle": unique("t")}).json()
    for char in ',;<>()[]\\"\x01':
        for email in (f"an{char}na@example.org", f"anna@exa{char}mple.org"):
            response = register(client, email, unique())
            assert response.status_code == 400 and response.json()["error"] == "invalid_email", email
            response = anna.post(f"/api/teams/{team['handle']}/invitations", json={"email": email, "role": "reader"})
            assert response.status_code == 400 and response.json()["error"] == "invalid_email", email
    for email in ("anna.b+skills@example.org", "o'neil@example.org", "anna@sub.example.co.uk"):
        assert register(client, email, unique()).status_code == 202, email


def test_logout_ends_the_session(client, signup, make_client):
    signup(client)
    token = client.cookies.get("__Host-session")
    assert client.post("/api/auth/logout").status_code == 204
    assert client.get("/api/account").status_code == 401
    assert make_client(cookies={"__Host-session": token}).get("/api/account").status_code == 401


def test_password_reset(client, signup, make_client, mailbox):
    account = signup(client)
    other_device = make_client()
    login(other_device, account["email"])
    response = client.post("/api/auth/reset-request", json={"email": account["email"]})
    assert response.status_code == 202
    token = mailbox.token(account["email"], "reset")
    # A weak password fails and leaves the link valid.
    response = client.post("/api/auth/reset", json={"token": token, "password": "kurz"})
    assert response.status_code == 400 and response.json()["error"] == "weak_password"
    new_password = "ein neues langes Passwort"
    assert client.post("/api/auth/reset", json={"token": token, "password": new_password}).status_code == 200
    assert other_device.get("/api/account").status_code == 401
    assert client.get("/api/account").status_code == 401
    assert login(client, account["email"]).status_code == 401
    assert login(client, account["email"], new_password).status_code == 200
    response = client.post("/api/auth/reset", json={"token": token, "password": "noch ein Passwort hier"})
    assert response.status_code == 400 and response.json()["error"] == "invalid_token"


def test_reset_request_for_an_unknown_email_looks_the_same(client, mailbox):
    email = f"{unique()}@example.org"
    response = client.post("/api/auth/reset-request", json={"email": email})
    assert response.status_code == 202 and response.json()["status"] == "check_mail"
    assert mailbox.messages(email) == []


def test_change_password(client, signup, make_client):
    account = signup(client)
    other_device = make_client()
    login(other_device, account["email"])
    response = client.post("/api/account/password", json={"current": "falsch falsch falsch", "new": "x" * 20})
    assert response.status_code == 401 and response.json()["error"] == "wrong_password"
    new_password = "ein anderes langes Passwort"
    response = client.post("/api/account/password", json={"current": PASSWORD, "new": new_password})
    assert response.status_code == 200
    assert client.get("/api/account").status_code == 200
    assert other_device.get("/api/account").status_code == 401
    assert login(make_client(), account["email"], new_password).status_code == 200


def test_rate_limit_login_per_ip(make_app, make_client):
    client = make_client(make_app(limits={"login_ip": Limit(3, 3600)}))
    for _ in range(3):
        assert login(client, f"{unique()}@example.org").status_code == 401
    response = login(client, f"{unique()}@example.org")
    assert response.status_code == 429 and response.json()["error"] == "rate_limited"
    assert 1 <= int(response.headers["retry-after"]) <= 3600


def test_rate_limit_login_per_account_behind_a_trusted_proxy(make_app, make_client):
    app = make_app(limits={"login_account": Limit(2, 3600)}, trusted_proxies=(ipaddress.ip_network("10.0.0.0/8"),))
    proxy = make_client(app, client=("10.0.0.2", 40000))
    email = f"{unique()}@example.org"
    for n in range(2):
        response = proxy.post("/api/auth/login", json={"email": email, "password": "x" * 12},
                              headers={"X-Forwarded-For": f"203.0.113.{n + 1}"})
        assert response.status_code == 401
    response = proxy.post("/api/auth/login", json={"email": email, "password": "x" * 12},
                          headers={"X-Forwarded-For": "203.0.113.9"})
    assert response.status_code == 429


def test_rate_limit_counts_the_client_behind_the_proxy(make_app, make_client):
    app = make_app(limits={"login_ip": Limit(2, 3600)}, trusted_proxies=(ipaddress.ip_network("10.0.0.0/8"),))
    proxy = make_client(app, client=("10.0.0.2", 40000))
    for n in range(2):
        response = proxy.post("/api/auth/login", json={"email": f"{unique()}@example.org", "password": "x" * 12},
                              headers={"X-Forwarded-For": "198.51.100.7"})
        assert response.status_code == 401
    blocked = proxy.post("/api/auth/login", json={"email": f"{unique()}@example.org", "password": "x" * 12},
                         headers={"X-Forwarded-For": "198.51.100.7"})
    assert blocked.status_code == 429
    other = proxy.post("/api/auth/login", json={"email": f"{unique()}@example.org", "password": "x" * 12},
                       headers={"X-Forwarded-For": "198.51.100.8"})
    assert other.status_code == 401
    # Without the trusted proxy, a forged X-Forwarded-For does not help: the peer address counts.
    direct = make_client(app, client=("192.0.2.50", 40000))
    for n in range(2):
        direct.post("/api/auth/login", json={"email": f"{unique()}@example.org", "password": "x" * 12},
                    headers={"X-Forwarded-For": f"198.51.100.{20 + n}"})
    forged = direct.post("/api/auth/login", json={"email": f"{unique()}@example.org", "password": "x" * 12},
                         headers={"X-Forwarded-For": "198.51.100.99"})
    assert forged.status_code == 429


def test_rate_limit_register_and_reset(make_app, make_client, mailbox):
    app = make_app(limits={"register_ip": Limit(2, 3600), "reset_account": Limit(1, 3600)})
    client = make_client(app)
    for _ in range(2):
        assert register(client, f"{unique()}@example.org", unique()).status_code == 202
    assert register(client, f"{unique()}@example.org", unique()).status_code == 429
    # RATE_LIMIT_RESET_ACCOUNT counts by the address: the same address is refused, from this client and from a client
    # with another IP address, and in capitals too. Another address from the same client still passes.
    email = f"{unique()}@example.org"
    assert client.post("/api/auth/reset-request", json={"email": email}).status_code == 202
    assert client.post("/api/auth/reset-request", json={"email": email}).status_code == 429
    assert client.post("/api/auth/reset-request", json={"email": email.upper()}).status_code == 429
    elsewhere = make_client(app, client=("198.51.100.44", 40000))
    assert elsewhere.post("/api/auth/reset-request", json={"email": email}).status_code == 429
    assert client.post("/api/auth/reset-request", json={"email": f"{unique()}@example.org"}).status_code == 202


def test_base_url_matches_the_origin_header_of_a_browser():
    assert Settings(base_url="HTTPS://It-Skills.net:443/").base_url == "https://it-skills.net"
    assert Settings(base_url="https://it-skills.localhost:8443").origin == "https://it-skills.localhost:8443"
    assert Settings(base_url="http://localhost:80").base_url == "http://localhost"
    for wrong in ("it-skills.net", "ftp://it-skills.net", "https://it-skills.net/app", "https://it-skills.net/?x=1"):
        with pytest.raises(ValueError):
            Settings(base_url=wrong)


def test_client_ip():
    trusted = (ipaddress.ip_network("10.0.0.0/8"),)
    assert client_ip("10.0.0.2", "203.0.113.5", trusted) == "203.0.113.5"
    assert client_ip("10.0.0.2", "198.51.100.1, 203.0.113.5", trusted) == "203.0.113.5"
    assert client_ip("10.0.0.2", "203.0.113.5, 10.0.0.9", trusted) == "203.0.113.5"
    assert client_ip("192.0.2.1", "203.0.113.5", trusted) == "192.0.2.1"
    assert client_ip("10.0.0.2", "not-an-ip", trusted) == "10.0.0.2"
    assert client_ip("10.0.0.2", None, trusted) == "10.0.0.2"
    assert client_ip("10.0.0.2", "203.0.113.5", ()) == "10.0.0.2"


def test_delete_account_removes_everything(client, signup, make_client, pool, sample_file):
    account = signup(client)
    other = make_client()
    other_account = signup(other)
    other.post("/api/maps", json={"title": "Bleibt"})
    imported = client.post("/api/maps/import", json=sample_file).json()
    client.patch(f"/api/maps/{imported['id']}", json={"visibility": "public"})
    share = client.post(f"/api/maps/{imported['id']}/shares").json()
    second_device = make_client()
    login(second_device, account["email"])
    client.post("/api/auth/reset-request", json={"email": account["email"]})
    with pool.connection() as conn:
        user_id = conn.execute("SELECT id FROM owners WHERE handle = %s", (account["handle"],)).fetchone()["id"]
    assert count_rows(pool, "documents", "map_id = %s", (imported["id"],)) > 0
    assert count_rows(pool, "email_tokens", "user_id = %s", (user_id,)) > 0

    response = client.post("/api/account/delete", json={"password": "das ist nicht mein Passwort"})
    assert response.status_code == 401
    assert client.post("/api/account/delete", json={"password": PASSWORD}).status_code == 204

    for table, where in (("owners", "id = %s"), ("users", "id = %s"), ("sessions", "user_id = %s"),
                         ("email_tokens", "user_id = %s"), ("maps", "owner_id = %s")):
        assert count_rows(pool, table, where, (user_id,)) == 0, table
    assert count_rows(pool, "documents", "map_id = %s", (imported["id"],)) == 0
    assert count_rows(pool, "share_links", "map_id = %s", (imported["id"],)) == 0
    assert client.get("/api/account").status_code == 401
    assert second_device.get("/api/account").status_code == 401
    assert make_client().get(f"/api/shared/{share['token']}/docs").status_code == 404
    assert make_client().get(f"/{account['handle']}/{imported['slug']}").status_code == 404
    assert login(client, account["email"]).status_code == 401
    # The other account keeps its map.
    assert [m["title"] for m in other.get("/api/maps").json()["maps"]] == ["Bleibt"]
    assert other.get("/api/account").json()["handle"] == other_account["handle"]


def test_export_of_all_maps(client, signup, sample_file):
    account = signup(client)
    client.post("/api/maps/import", json=sample_file)
    client.post("/api/maps", json={"title": "Leere Karte"})
    response = client.get("/api/account/export")
    assert response.status_code == 200 and response.headers["content-type"] == "application/zip"
    archive = zipfile.ZipFile(io.BytesIO(response.content))
    names = sorted(archive.namelist())
    assert names == ["account.json", "beispielkarte-fuer-tests.json", "leere-karte.json"]
    info = json.loads(archive.read("account.json"))
    assert info["handle"] == account["handle"] and info["language"] == "en" and len(info["maps"]) == 2
    assert all(m["embed"] == {"allow": "all", "origins": []} for m in info["maps"])
    exported = json.loads(archive.read("beispielkarte-fuer-tests.json"))
    assert exported["format"] == "it-skills-map" and exported["collections"] == sample_file["collections"]
    empty = json.loads(archive.read("leere-karte.json"))
    assert empty["collections"] == {} and empty["title"] == "Leere Karte"


def test_tokens_are_stored_hashed(client, signup, pool):
    signup(client)
    token = client.cookies.get("__Host-session")
    with pool.connection() as conn:
        assert conn.execute("SELECT 1 FROM sessions WHERE id_hash = %s", (hash_token(token),)).fetchone()
        assert not conn.execute("SELECT 1 FROM sessions WHERE id_hash = %s", (token.encode(),)).fetchone()
