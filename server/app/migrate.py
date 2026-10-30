"""A small migration runner: applies each file in server/migrations once, in name order, and records it
in the table schema_migrations. Run it with `python -m app.migrate`; the app also runs it at start.

It logs each file that it applies, and one line with the version of the database at the end. The app sends these lines
to the log of its container (main.log_to_stderr)."""
from __future__ import annotations

import logging
import sys
from pathlib import Path

import psycopg

MIGRATIONS = Path(__file__).resolve().parent.parent / "migrations"
LOCK_KEY = 4_711_2026  # pg_advisory_lock key, so that two app processes never migrate at the same time

log = logging.getLogger("skill-map.migrate")


def pending(conn: psycopg.Connection, until: str | None = None) -> list[Path]:
    """The files that are not applied yet, in name order; with until, only up to that name."""
    done = {row[0] for row in conn.execute("SELECT version FROM schema_migrations")}
    return [path for path in sorted(MIGRATIONS.glob("*.sql"))
            if path.stem not in done and (until is None or path.stem <= until)]


def migrate(conninfo: str, until: str | None = None) -> list[str]:
    """Applies the pending files, each in its own transaction. until stops after that file (for tests)."""
    applied = []
    with psycopg.connect(conninfo, autocommit=True) as conn:
        conn.execute("SELECT pg_advisory_lock(%s)", (LOCK_KEY,))
        try:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations ("
                " version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
            )
            for path in pending(conn, until):
                with conn.transaction():
                    conn.execute(path.read_text(encoding="utf-8"))
                    conn.execute("INSERT INTO schema_migrations (version) VALUES (%s)", (path.stem,))
                applied.append(path.stem)
                log.info("applied the migration %s", path.stem)
            latest = conn.execute("SELECT max(version) FROM schema_migrations").fetchone()[0]
            # With until (the tests), later files can still be pending.
            log.info("the database is up to date: %s" if until is None else "the database is at %s",
                     latest or "no migration")
        finally:
            conn.execute("SELECT pg_advisory_unlock(%s)", (LOCK_KEY,))
    return applied


def main() -> int:
    from .config import Settings

    applied = migrate(Settings.from_env().database_url)
    print("applied: " + ", ".join(applied) if applied else "the database is up to date")
    return 0


if __name__ == "__main__":
    sys.exit(main())
