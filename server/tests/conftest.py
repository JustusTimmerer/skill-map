"""Shared fixtures. The tests run against the real PostgreSQL and mailpit of the compose stack:
`docker compose -f server/compose.yaml run --rm tests`. They use their own database (TEST_DATABASE),
which they create fresh at the start, so the data of the running app stays untouched."""
from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from pathlib import Path

import httpx2
import psycopg
import pytest
from psycopg import sql
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
from starlette.testclient import TestClient

from app.config import DEFAULT_LIMITS, Limit, Settings
from app.main import create_app
from app.migrate import migrate

FIXTURES = Path(__file__).parent / "fixtures"
BASE = "https://it-skills.test"
DOMAIN = "it-skills.test"
HEADERS = {"X-Requested-With": "it-skills", "Origin": BASE}
PASSWORD = "korrekt Pferd Batterie 7"
TEST_DATABASE = os.environ.get("TEST_DATABASE", "skillmap_test")
MAILPIT_URL = os.environ.get("MAILPIT_URL", "http://mailpit:8025")
# A word of the subject of each kind of mail, in English and in German (server/app/i18n/<language>/mail.json).
SUBJECTS = {"confirm": ("Please confirm", "bestätige"), "reset": ("New password", "Neues Passwort"),
            "registered": ("Your account at", "Dein Konto bei"), "invitation": ("Invitation", "Einladung")}


@pytest.fixture(scope="session")
def database() -> str:
    with psycopg.connect("dbname=postgres", autocommit=True) as conn:
        conn.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(TEST_DATABASE)))
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(TEST_DATABASE)))
    conninfo = f"dbname={TEST_DATABASE}"
    migrate(conninfo)
    return conninfo


@pytest.fixture(scope="session")
def pool(database):
    pool = ConnectionPool(database, min_size=1, max_size=8, kwargs={"row_factory": dict_row}, open=True)
    yield pool
    pool.close()


@pytest.fixture(autouse=True)
def clean(pool):
    """Every test starts with empty tables (schema_migrations stays)."""
    with pool.connection() as conn:
        conn.execute("TRUNCATE owners, rate_limits, freed_handles CASCADE")


def make_settings(database: str, **changes) -> Settings:
    # High rate limits by default; the rate limit tests set low ones.
    limits = {name: Limit(1000, 60) for name in DEFAULT_LIMITS}
    limits.update(changes.pop("limits", {}))
    values = {
        "base_url": BASE,
        "database_url": database,
        "base_domain": DOMAIN,
        "smtp_host": os.environ.get("SMTP_HOST", "mailpit"),
        "smtp_port": int(os.environ.get("SMTP_PORT", "1025")),
        "page_file": str(FIXTURES / "page.html"),
        "start_file": str(FIXTURES / "start.html"),
        "limits": limits,
    }
    return Settings(**{**values, **changes})


@pytest.fixture
def make_app(pool, database):
    def make(**changes):
        return create_app(make_settings(database, **changes), pool=pool)
    return make


@pytest.fixture
def app(make_app):
    return make_app()


@pytest.fixture
def make_client(app):
    """A new browser: its own cookie jar, with the CSRF headers of the page."""
    def make(on=None, headers=HEADERS, **kwargs):
        return TestClient(on or app, base_url=BASE, headers=headers, **kwargs)
    return make


@pytest.fixture
def client(make_client):
    return make_client()


class Mailbox:
    """The mails in mailpit, read through its API."""

    def __init__(self, url: str):
        self.http = httpx2.Client(base_url=url, timeout=10)

    def messages(self, to: str) -> list[dict]:
        response = self.http.get("/api/v1/search", params={"query": f'to:"{to}"'})
        response.raise_for_status()
        return response.json()["messages"]

    def wait(self, to: str, subject, count: int = 1, timeout: float = 10) -> dict:
        """The newest mail to `to` whose subject contains `subject`, once there are `count` of them. subject can also
        be a tuple of texts, one of which the subject contains: the subject in each language."""
        subjects = subject if isinstance(subject, tuple) else (subject,)
        deadline = time.monotonic() + timeout
        while True:
            found = [m for m in self.messages(to) if any(part in m["Subject"] for part in subjects)]
            if len(found) >= count:
                return self.http.get(f"/api/v1/message/{found[0]['ID']}").json()
            if time.monotonic() > deadline:
                raise AssertionError(f"no mail {subject!r} to {to} within {timeout} s")
            time.sleep(0.2)

    def token(self, to: str, kind: str, count: int = 1) -> str:
        """The token of the newest mail of a kind, in any language: the language of the account decides it."""
        text = self.wait(to, SUBJECTS[kind], count)["Text"]
        match = re.search(rf"#{kind}=([A-Za-z0-9_-]+)", text)
        assert match, text
        return match[1]


@pytest.fixture(scope="session")
def mailbox() -> Mailbox:
    return Mailbox(MAILPIT_URL)


def unique(prefix: str = "u") -> str:
    return prefix + uuid.uuid4().hex[:10]


@pytest.fixture
def signup(mailbox):
    """Registers, confirms through the mail and signs in. Returns the account data."""
    def run(client, handle: str | None = None, email: str | None = None, password: str = PASSWORD,
            language: str | None = None) -> dict:
        handle = handle or unique()
        email = email or f"{handle}@example.org"
        body = {"email": email, "password": password, "handle": handle, **({"language": language} if language else {})}
        response = client.post("/api/auth/register", json=body)
        assert response.status_code == 202, response.text
        token = mailbox.token(email, "confirm")
        assert client.post("/api/auth/confirm", json={"token": token, "password": password}).status_code == 200
        response = client.post("/api/auth/login", json={"email": email, "password": password})
        assert response.status_code == 200, response.text
        return {"handle": handle, "email": email, "password": password}
    return run


_QUICK_HASH: list[str] = []


@pytest.fixture
def quick_user(make_client, pool):
    """A confirmed user with a session, written straight into the database: much faster than signup, for
    the tests that need many users, with the language en unless the test names another. Returns a client with the
    attributes handle, email and user_id."""
    from app.security import hash_password, hash_token, new_token

    if not _QUICK_HASH:
        _QUICK_HASH.append(hash_password(PASSWORD))

    def make(handle: str | None = None, language: str = "en"):
        handle = handle or unique()
        email = f"{handle}@example.org"
        token = new_token()
        with pool.connection() as conn:
            user_id = conn.execute("INSERT INTO owners (kind, handle) VALUES ('user', %s) RETURNING id",
                                   (handle,)).fetchone()["id"]
            conn.execute("INSERT INTO users (id, email, password_hash, confirmed_at, language)"
                         " VALUES (%s, %s, %s, now(), %s)", (user_id, email, _QUICK_HASH[0], language))
            conn.execute("INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (%s, %s, now() + interval '1 day')",
                         (hash_token(token), user_id))
        client = make_client(cookies={"__Host-session": token})
        client.handle, client.email, client.user_id = handle, email, user_id
        return client
    return make


@pytest.fixture
def sample_file() -> dict:
    return json.loads((FIXTURES / "sample-map.json").read_text(encoding="utf-8"))


def count_rows(pool, table: str, where: str = "true", params: tuple = ()) -> int:
    with pool.connection() as conn:
        return conn.execute(f"SELECT count(*) AS n FROM {table} WHERE {where}", params).fetchone()["n"]


class Background(threading.Thread):
    """Runs a call in a thread, for requests that must run at the same moment. result() waits for the call and
    returns its value, or raises its error."""

    def __init__(self, call):
        super().__init__(daemon=True)
        self.call, self.value, self.error = call, None, None
        self.start()

    def run(self):
        try:
            self.value = self.call()
        except BaseException as error:  # noqa: BLE001 - result() raises it in the test
            self.error = error

    def result(self, timeout: float = 30):
        self.join(timeout)
        assert not self.is_alive(), f"the call did not end within {timeout} s"
        if self.error is not None:
            raise self.error
        return self.value


def wait_for_locks(pool, count: int, timeout: float = 15) -> None:
    """Waits until `count` connections to the test database wait for a lock. A race test holds a lock from outside,
    lets its requests run into it, and releases it once every request waits."""
    deadline = time.monotonic() + timeout
    while True:
        with pool.connection() as conn:
            waiting = conn.execute(
                "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'"
            ).fetchone()["n"]
        if waiting >= count:
            return
        if time.monotonic() > deadline:
            raise AssertionError(f"{waiting} of {count} connections wait for a lock after {timeout} s")
        time.sleep(0.05)
