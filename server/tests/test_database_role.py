"""The app connects to PostgreSQL as a role without admin rights (README.md, "Database roles").

With an admin role, any SQL injection would become a takeover of the database server, for example with
COPY ... TO PROGRAM. The one-shot service db-setup of compose.yaml (db-setup.sql) makes the role of the app and gives it
the database. These tests need `docker compose up`. They connect as the admin role of the tests (PGUSER) to the database
of the app (PGDATABASE), and they look at the sessions that the running app holds there."""
from __future__ import annotations

import os
import time
import uuid

import psycopg
import pytest
from psycopg import errors, sql

pytestmark = pytest.mark.skipif(not os.environ.get("STACK_URL"),
                                reason="STACK_URL is not set (run the tests in the compose stack)")


@pytest.fixture(scope="module")
def admin():
    with psycopg.connect("", autocommit=True) as conn:
        yield conn


def _sessions(admin) -> list[tuple]:
    """The sessions of the app: every client session in the database of the app, except this one."""
    deadline = time.monotonic() + 10
    while True:
        rows = admin.execute(
            "SELECT a.usename, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,"
            "       (SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid)"
            "  FROM pg_stat_activity a JOIN pg_roles r ON r.oid = a.usesysid"
            " WHERE a.datname = current_database() AND a.backend_type = 'client backend'"
            "   AND a.pid <> pg_backend_pid()").fetchall()
        # The pool of the app keeps at least one connection open. It can be away for a moment when it renews it.
        if rows or time.monotonic() > deadline:
            return rows
        time.sleep(0.5)


@pytest.fixture(scope="module")
def app_role(admin) -> str:
    roles = {row[0] for row in _sessions(admin)}
    assert len(roles) == 1, roles
    return roles.pop()


def test_the_app_connects_as_a_role_without_admin_rights(admin):
    sessions = _sessions(admin)
    assert sessions, "the app holds no session in its database"
    for name, superuser, createdb, createrole, replication, bypassrls, memberships in sessions:
        assert name != admin.info.user, "the app connects as the admin role"
        assert not superuser, f"{name} is a superuser"
        assert not createdb and not createrole, f"{name} can create a database or a role"
        assert not replication and not bypassrls, name
        assert memberships == 0, f"{name} is a member of another role and has its rights"


def test_the_app_role_cannot_create_a_database_a_role_or_run_a_program(admin, app_role):
    name = "role-test-" + uuid.uuid4().hex[:8]
    attempts = {
        "create a database": sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)),
        "create a role": sql.SQL("CREATE ROLE {}").format(sql.Identifier(name)),
        "make itself a superuser": sql.SQL("ALTER ROLE {} SUPERUSER").format(sql.Identifier(app_role)),
        "run a program": sql.SQL("COPY (SELECT 1) TO PROGRAM 'true'"),
        "read a file of the server": sql.SQL("SELECT pg_read_file('PG_VERSION')"),
    }
    admin.execute(sql.SQL("SET ROLE {}").format(sql.Identifier(app_role)))
    try:
        for what, statement in attempts.items():
            with pytest.raises(errors.InsufficientPrivilege):
                admin.execute(statement)
                pytest.fail(f"the role of the app can {what}")
    finally:
        admin.execute("RESET ROLE")
        # A role with admin rights made the database and the role of the attempts. Remove them.
        admin.execute(sql.SQL("DROP DATABASE IF EXISTS {}").format(sql.Identifier(name)))
        admin.execute(sql.SQL("DROP ROLE IF EXISTS {}").format(sql.Identifier(name)))


def test_the_app_role_owns_the_database_and_its_objects(admin, app_role):
    # The app runs the migrations at its start, so it must own every object that a migration changes.
    owners = admin.execute(
        "SELECT (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()),"
        "       (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public')").fetchone()
    assert owners == (app_role, app_role)
    objects = dict(admin.execute(
        "SELECT c.relname, pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace"
        " WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'i')").fetchall())
    assert {"schema_migrations", "owners", "users", "maps", "documents", "share_links"} <= set(objects)
    assert {name: owner for name, owner in objects.items() if owner != app_role} == {}


APP_PASSFILE = os.environ.get("APP_PASSFILE", "")


def _connect_as_app(app_role: str, **kwargs) -> psycopg.Connection:
    """A connection as the role of the app, with the password file that the app reads (PGPASSFILE). The empty password
    keeps libpq from taking PGPASSWORD of the tests, which is the password of the admin role."""
    return psycopg.connect("", user=app_role, password="", passfile=APP_PASSFILE, **kwargs)


@pytest.mark.skipif(not APP_PASSFILE, reason="APP_PASSFILE is not set")
def test_the_app_role_has_a_password_of_its_own(app_role):
    # Without POSTGRES_APP_PASSWORD, the role of the app got the password of the admin role, so code in the app container
    # knew the password of the admin. db-setup now makes a password of its own and writes it to the file of the app.
    with pytest.raises(psycopg.OperationalError, match="password authentication failed"):
        psycopg.connect("", user=app_role, password=os.environ["PGPASSWORD"]).close()
    with _connect_as_app(app_role) as conn:
        assert conn.execute("SELECT current_user").fetchone()[0] == app_role


@pytest.mark.skipif(not APP_PASSFILE, reason="APP_PASSFILE is not set")
def test_the_app_role_reaches_only_its_own_database(admin, app_role):
    # PostgreSQL gives CONNECT on each database to PUBLIC. db-setup takes it back on postgres and template1.
    privilege = "SELECT has_database_privilege(%s, %s, 'CONNECT')"
    for name in ("postgres", "template1"):
        assert admin.execute(privilege, (app_role, name)).fetchone()[0] is False, name
        with pytest.raises(psycopg.OperationalError, match=f'permission denied for database "{name}"'):
            _connect_as_app(app_role, dbname=name).close()
        assert admin.execute(privilege, (admin.info.user, name)).fetchone()[0] is True, f"the admin role keeps {name}"
    with _connect_as_app(app_role) as conn:
        assert conn.execute("SELECT current_database()").fetchone()[0] == admin.info.dbname
