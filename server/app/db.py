"""The connection pool. A request takes a connection with `with pool.connection() as conn:`; the block
commits at its end and rolls back on an exception."""
from __future__ import annotations

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .config import Settings


def make_pool(settings: Settings) -> ConnectionPool:
    # An empty DATABASE_URL lets libpq read PGHOST, PGUSER, PGPASSWORD and PGDATABASE.
    return ConnectionPool(
        settings.database_url,
        min_size=settings.pool_min,
        max_size=settings.pool_max,
        kwargs={"row_factory": dict_row},
        open=False,
        name="skill-map",
    )
