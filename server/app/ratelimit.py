"""Rate limits in PostgreSQL: a counter per bucket, key and fixed time window.

A hit through enforce() commits at once in its own transaction, so it counts even when the request fails afterwards.
enforce_in() counts in the transaction of the request instead: the hit counts only if the request succeeds. A bucket per
IP takes the key of sessions.ip_key_of(), so an IPv6 client counts by its /64 network."""
from __future__ import annotations

import random
import time

from psycopg_pool import ConnectionPool

from .config import Limit
from .errors import ApiError
from .security import hash_key


def _count(conn, bucket: str, key: str, limit: Limit) -> int | None:
    now = int(time.time())
    window = now - now % limit.seconds
    row = conn.execute(
        "INSERT INTO rate_limits (bucket, key, window_start, hits) VALUES (%s, %s, to_timestamp(%s), 1)"
        " ON CONFLICT (bucket, key, window_start) DO UPDATE SET hits = rate_limits.hits + 1"
        " RETURNING hits",
        (bucket, hash_key(key), window),
    ).fetchone()
    if row["hits"] > limit.count:
        return max(1, window + limit.seconds - now)
    return None


def hit(pool: ConnectionPool, bucket: str, key: str, limit: Limit) -> int | None:
    """Counts one request. Returns the seconds until the window ends if the limit is exceeded, else None."""
    with pool.connection() as conn:
        retry_after = _count(conn, bucket, key, limit)
        if random.random() < 0.02:
            conn.execute("DELETE FROM rate_limits WHERE window_start < now() - interval '2 days'")
    return retry_after


def _refuse(retry_after: int | None) -> None:
    if retry_after is not None:
        raise ApiError(429, "rate_limited", headers={"Retry-After": str(retry_after)})


def enforce(pool: ConnectionPool, limits: dict, bucket: str, key: str) -> None:
    _refuse(hit(pool, bucket, key, limits[bucket]))


def enforce_in(conn, limits: dict, bucket: str, key: str) -> None:
    """Counts one request in the open transaction conn. A refused request rolls the transaction back, and the hit with
    it, so the counter stays at the limit and refuses every further request until the window ends. Two requests with the
    same key wait for each other at the counter, so the limit holds under parallel requests too."""
    _refuse(_count(conn, bucket, key, limits[bucket]))
