"""Held handles. A handle is also a public address: /<handle> and /<handle>/<slug>, the embed view /e/<handle>/<slug>
in frames on other sites, and the subdomain <handle>.<domain>. A handle that a team or an account frees stays blocked for HANDLE_HOLD_DAYS
(migration 0005_freed_handles), so that no stranger takes over the old addresses of another owner.

Three paths free a public handle: the rename of a team, the delete of a team, and the delete of an account with the
teams that go with it. Each writes a row with hold(). The owner that freed a handle may take it back, for example a team
that renames back. An account that nobody confirmed never had a public page, so its handle gets no row: a second
registration that replaces it, and the cleanup of accounts that nobody confirmed, write nothing.

A held handle gets the same answer as a taken handle, 409 handle_taken, so the answer does not tell which it is."""
from __future__ import annotations

from psycopg_pool import ConnectionPool

from .errors import ApiError


def handle_taken() -> ApiError:
    return ApiError(409, "handle_taken")


def forget_expired(pool: ConnectionPool, hold_days: int) -> None:
    """Deletes the rows whose hold has ended. It runs in its own short transaction before the transaction of the request,
    and SKIP LOCKED never waits, so it holds no lock while a request runs. A row whose hold has ended blocks nothing
    even before it goes, because check_free() reads only the rows of the hold."""
    with pool.connection() as conn:
        conn.execute(
            "DELETE FROM freed_handles WHERE handle IN (SELECT handle FROM freed_handles"
            " WHERE freed_at <= now() - make_interval(days => %s) FOR UPDATE SKIP LOCKED)",
            (hold_days,),
        )


def check_free(conn, handle: str, hold_days: int, owner_id=None) -> None:
    """Raises handle_taken if another owner than owner_id has the handle, or if the handle is held for another owner.

    One statement reads both tables in one snapshot. A rename or a delete changes the row of the owner and writes the
    hold in one commit. So the statement sees either the old owner or the hold, and never a free handle between them."""
    row = conn.execute(
        "SELECT EXISTS (SELECT 1 FROM owners WHERE handle = %(handle)s AND id IS DISTINCT FROM %(owner)s)"
        " OR EXISTS (SELECT 1 FROM freed_handles WHERE handle = %(handle)s AND owner_id IS DISTINCT FROM %(owner)s"
        " AND freed_at > now() - make_interval(days => %(days)s)) AS taken",
        {"handle": handle, "owner": owner_id, "days": hold_days},
    ).fetchone()
    if row["taken"]:
        raise handle_taken()


def hold(conn, handle: str, owner_id) -> None:
    """Blocks a freed handle for every owner but owner_id, from now on for HANDLE_HOLD_DAYS."""
    conn.execute(
        "INSERT INTO freed_handles (handle, owner_id) VALUES (%s, %s)"
        " ON CONFLICT (handle) DO UPDATE SET owner_id = EXCLUDED.owner_id, freed_at = EXCLUDED.freed_at",
        (handle, owner_id),
    )


def take(conn, handle: str) -> None:
    """An owner uses the handle again: its row goes. check_free() passed, so the row is the hold of this owner, or a row
    whose hold has ended."""
    conn.execute("DELETE FROM freed_handles WHERE handle = %s", (handle,))
