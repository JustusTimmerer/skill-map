"""The document store of a map, and the map file (format "it-skills-map") for export and import.

A map holds documents in collections, like the database of the page: collection name, document id and a
JSON object. Every write raises the version of the map by one."""
from __future__ import annotations

import json
import math
import re

from psycopg import errors as pg_errors
from psycopg.types.json import Jsonb

from .errors import ApiError, bad, not_found
from .texts import text
from .util import CONTROL, SURROGATE, iso, now_iso, slugify

FORMAT = "it-skills-map"
SCHEMA = 1
# Each pattern must match the whole text (fullmatch): with re.match, "$" also matches before a closing line break.
COLLECTION_RE = re.compile(r"[a-z][a-z0-9_-]{0,40}")
SLUG_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?")
# The rules of titles and document ids of selfhost/FORMAT.md, "Top level" and "Names and ids". The site holds the same
# rules (validId, parseFile and cleanTitle in selfhost/runtime/local.js), so a map file that one side takes, the other
# side takes too (finding B4 of the final review).
MAX_TITLE = 120
MAX_ID = 200
# "." and ".." are no path segment of an address: a browser removes them from the address of a write, so the page could
# never write or delete such a document. "__proto__" is a special key of a JavaScript object.
RESERVED_IDS = frozenset({".", "..", "__proto__"})
# The stricter rules of three collections, because the page writes their ids into class names and attributes. A station
# id must not end in a small "i", which marks an indirect use in places, and PRIVAT names the private projects.
AREA_ID = re.compile(r"[a-z][a-z0-9_-]{0,39}")
STATION_ID = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,39}")
GROUP_ID = re.compile(r"[a-z0-9][a-z0-9_-]{0,119}")
RESERVED_STATION = "PRIVAT"
# The white space of JavaScript (\s), so that a title from a file becomes the same text on the server as on the site.
WHITE_SPACE = re.compile(r"[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+")
VISIBILITIES = ("private", "link", "public")
MAX_DOCUMENT = 256 * 1024
MAX_MAP = 4 * 1024 * 1024
MAX_DEPTH = 64
# Slugs that would hide a path of the app on a subdomain such as https://<handle>.<domain>/<slug>.
RESERVED_SLUGS = frozenset({"api", "u", "s", "account", "konto", "static", "assets", "vendor", "embed", "favicon", "robots"})
# The unique key of the slugs of one owner (migrations/0001_initial.sql), and how often a picked slug is tried again
# when another request takes it at the same moment.
SLUG_KEY = "maps_owner_id_slug_key"
SLUG_TRIES = 5

# Steps that turn a map file of an older schema into the next one: {old schema: function(file) -> file}.
SCHEMA_STEPS: dict = {}

# Embedding: "all" lets every site frame the embed view of a map, "origins" only the listed sites.
EMBED_ALLOW = ("all", "origins")
MAX_EMBED_ORIGINS = 20
MAX_ORIGIN_LENGTH = 200
_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
# An origin goes into a Content-Security-Policy header, so this pattern allows no space, no ";" and no ",".
ORIGIN_RE = re.compile(rf"^(https?)://({_LABEL}(?:\.{_LABEL})*)(?::(\d{{1,5}}))?/?$")


def check_collection(name) -> str:
    if not isinstance(name, str) or not COLLECTION_RE.fullmatch(name):
        raise bad("invalid_collection")
    return name


def check_doc_id(collection: str, doc_id) -> str:
    """A document id of the collection: 1 to 200 characters, no "/", no control character, no half of a UTF-16 pair,
    not ".", ".." or "__proto__", and the stricter rule of areas, stations and groups (selfhost/FORMAT.md)."""
    if (not isinstance(doc_id, str) or not 1 <= len(doc_id) <= MAX_ID or "/" in doc_id or CONTROL.search(doc_id)
            or SURROGATE.search(doc_id) or doc_id in RESERVED_IDS):
        raise bad("invalid_id")
    if collection == "areas" and not AREA_ID.fullmatch(doc_id):
        raise bad("invalid_id", "areas")
    if collection == "stations" and (not STATION_ID.fullmatch(doc_id) or doc_id.endswith("i")
                                     or doc_id == RESERVED_STATION):
        raise bad("invalid_id", "stations", code=RESERVED_STATION)
    if collection == "groups" and not GROUP_ID.fullmatch(doc_id):
        raise bad("invalid_id", "groups")
    return doc_id


def check_title(title) -> str:
    title = title.strip() if isinstance(title, str) else ""
    if not 1 <= len(title) <= MAX_TITLE or CONTROL.search(title) or SURROGATE.search(title):
        raise bad("invalid_title", max=MAX_TITLE)
    return title


def file_title(text: str) -> str:
    """The title of a map file as the site reads it (cleanTitle in selfhost/runtime/local.js): each run of white space
    becomes one space, with none at the ends, and a longer title keeps its first MAX_TITLE characters."""
    return WHITE_SPACE.sub(" ", text).strip(" ")[:MAX_TITLE].strip(" ")


def check_slug(slug) -> str:
    if not isinstance(slug, str) or not SLUG_RE.fullmatch(slug) or "--" in slug or slug in RESERVED_SLUGS:
        raise bad("invalid_slug")
    return slug


def check_visibility(value) -> str:
    if value not in VISIBILITIES:
        raise bad("invalid_visibility")
    return value


def check_origin(value) -> str:
    """An origin of a site that may embed a map, as scheme://host[:port]. Capitals become small letters, a default
    port and a closing "/" go away. A path, a query, a user name, a wildcard, an IPv6 address and a host name without
    a dot (other than localhost) are errors."""
    text = value.strip().lower() if isinstance(value, str) else ""
    match = ORIGIN_RE.match(text) if len(text) <= MAX_ORIGIN_LENGTH else None
    port = int(match[3]) if match and match[3] else None
    if not match or (port is not None and not 1 <= port <= 65535) or ("." not in match[2] and match[2] != "localhost"):
        shown = value.strip()[:80] if isinstance(value, str) else str(value)[:80]
        raise bad("invalid_origin", origin=shown)
    scheme, host = match[1], match[2]
    if port == {"https": 443, "http": 80}[scheme]:
        port = None
    return f"{scheme}://{host}" + (f":{port}" if port else "")


def check_embed(allow, origins, current_allow: str, current_origins: list) -> tuple[str, list]:
    """The new embed setting of a map from a change: allow and origins are None when the change leaves them out."""
    if allow is not None and allow not in EMBED_ALLOW:
        raise bad("invalid_embed")
    result: list = list(current_origins)
    if origins is not None:
        result = []
        for origin in origins:
            origin = check_origin(origin)
            if origin not in result:
                result.append(origin)
        if len(result) > MAX_EMBED_ORIGINS:
            raise bad("too_many_origins", max=MAX_EMBED_ORIGINS)
    return (allow if allow is not None else current_allow), result


def frame_ancestors(map_row: dict) -> str:
    """The sources of the CSP directive frame-ancestors for the embed view of a map."""
    if map_row["embed_allow"] == "all":
        return "*"
    return " ".join(["'self'", *map_row["embed_origins"]])


def _check_value(value, depth: int = 0) -> None:
    if depth > MAX_DEPTH:
        raise bad("invalid_document", "tooDeep")
    if isinstance(value, str):
        if "\x00" in value:
            raise bad("invalid_document", "nullCharacter")
        if SURROGATE.search(value):
            raise bad("invalid_document", "notUtf8")
    elif isinstance(value, float):
        if not math.isfinite(value):
            raise bad("invalid_document", "notFinite")
    elif isinstance(value, dict):
        for key, item in value.items():
            _check_value(key, depth + 1)
            _check_value(item, depth + 1)
    elif isinstance(value, list):
        for item in value:
            _check_value(item, depth + 1)


def document_size(data) -> int:
    """The size of a document: the bytes of its compact JSON in UTF-8."""
    if not isinstance(data, dict):
        raise bad("invalid_document", "notObject")
    _check_value(data)
    size = len(json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    if size > MAX_DOCUMENT:
        raise ApiError(413, "document_too_large", kb=MAX_DOCUMENT // 1024)
    return size


def map_too_large() -> ApiError:
    return ApiError(413, "map_too_large", mb=MAX_MAP // (1024 * 1024))


def unique_slug(conn, owner_id, wanted: str, keep_id=None) -> str:
    """wanted, or wanted-2, wanted-3 ... if another map of the owner already has it."""
    base = wanted if wanted not in RESERVED_SLUGS else f"{wanted}-map"
    stem = base[:56].rstrip("-")
    taken = {row["slug"] for row in conn.execute(
        "SELECT slug FROM maps WHERE owner_id = %s AND (slug = %s OR slug LIKE %s) AND id IS DISTINCT FROM %s",
        (owner_id, base, stem + "-%", keep_id),
    )}
    if base not in taken:
        return base
    number = 2
    while f"{stem}-{number}" in taken:
        number += 1
    return f"{stem}-{number}"


def too_many_maps(max_maps: int) -> ApiError:
    # count picks the plural form of the text: "at most 1 map" (texts.py).
    return ApiError(409, "too_many_maps", max=max_maps, count=max_maps)


def slug_taken() -> ApiError:
    return ApiError(409, "slug_taken")


def lock_owner(conn, owner_id) -> bool:
    """Locks the row of an owner (a user or a team) until the end of the transaction, and returns False if the owner is
    gone. Each write that counts what an owner has takes this lock before it counts: a new map, an import and a move
    count the maps of the owner (check_room), and a new team counts the teams of the user (teams.create_team). So two
    parallel requests count one after the other, and the second one counts the map or the team of the first.

    The lock order is: the row of an owner first, then the row of a map. A move locks its map only after the row of the
    team, and the delete of a team or an account locks the row of the owner before its delete reaches the maps. So no
    two transactions wait for each other in a circle.

    FOR NO KEY UPDATE waits for every other lock of this kind and for each change or delete of the owner row. It does not
    wait for the foreign key checks of new rows that point to the owner, for example a map that another transaction
    inserts. Those need no order here, and the slug of such a map has its own retry (write_with_slug)."""
    return conn.execute("SELECT 1 FROM owners WHERE id = %s FOR NO KEY UPDATE", (owner_id,)).fetchone() is not None


def check_room(conn, owner_id, max_maps: int) -> None:
    """Raises too_many_maps if the owner (a user or a team) has max_maps maps. It locks the row of the owner before it
    counts (lock_owner), so parallel creates, imports and moves stop exactly at the limit. An owner that another request
    deleted meanwhile gives 404."""
    if not lock_owner(conn, owner_id):
        raise not_found()
    count = conn.execute("SELECT count(*) AS n FROM maps WHERE owner_id = %s", (owner_id,)).fetchone()["n"]
    if count >= max_maps:
        raise too_many_maps(max_maps)


def slug_used(conn, owner_id, slug: str) -> bool:
    return conn.execute("SELECT 1 FROM maps WHERE owner_id = %s AND slug = %s", (owner_id, slug)).fetchone() is not None


def write_with_slug(conn, owner_id, slug: str | None, wanted: str, write):
    """Runs write(slug) in a savepoint and returns its result. Another request can take the slug between the check and
    the write; the unique key (owner_id, slug) then refuses the write. A slug that the request names (slug) then gets 409
    slug_taken. A slug that the server picks from wanted (slug None) is picked again, as the next free one."""
    for _ in range(SLUG_TRIES):
        chosen = slug if slug is not None else unique_slug(conn, owner_id, wanted)
        try:
            with conn.transaction():
                return write(chosen)
        except pg_errors.UniqueViolation as error:
            if error.diag.constraint_name != SLUG_KEY:
                raise
            if slug is not None:
                raise slug_taken() from None
    raise slug_taken()


def create_map(conn, owner_id, user_id, title: str, slug: str | None, visibility: str, max_maps: int) -> dict:
    check_room(conn, owner_id, max_maps)
    if slug is not None and slug_used(conn, owner_id, slug):
        raise slug_taken()
    return write_with_slug(conn, owner_id, slug, slugify(title), lambda chosen: conn.execute(
        "INSERT INTO maps (owner_id, created_by, title, slug, visibility) VALUES (%s, %s, %s, %s, %s) RETURNING *",
        (owner_id, user_id, title, chosen, visibility),
    ).fetchone())


def bump(conn, map_row: dict, size_delta: int = 0) -> dict:
    return conn.execute(
        "UPDATE maps SET version = version + 1, size_bytes = size_bytes + %s, updated_at = now()"
        " WHERE id = %s RETURNING *",
        (size_delta, map_row["id"]),
    ).fetchone()


def check_base(conn, map_row: dict, collection: str, doc_id: str, base: int | None, deleting: bool = False) -> None:
    """A write with base: the version of the map that the writer knows the document from. If the document changed
    after it, the write would undo a change that the writer never saw, so it gets 409 conflict. A delete of a document
    that somebody else deleted already is no conflict. map_row must come from map_for(..., lock=True) in the same transaction."""
    if base is None:
        return
    row = conn.execute(
        "SELECT version, data IS NULL AS gone FROM documents WHERE map_id = %s AND collection = %s AND doc_id = %s",
        (map_row["id"], collection, doc_id),
    ).fetchone()
    if row and row["version"] > base and not (deleting and row["gone"]):
        raise ApiError(409, "conflict")


def put_document(conn, map_row: dict, collection: str, doc_id: str, data: dict) -> dict:
    """Writes one document. map_row must come from map_for(..., lock=True) in the same transaction."""
    size = document_size(data)
    old = conn.execute(
        "SELECT size_bytes FROM documents WHERE map_id = %s AND collection = %s AND doc_id = %s AND data IS NOT NULL",
        (map_row["id"], collection, doc_id),
    ).fetchone()
    delta = size - (old["size_bytes"] if old else 0)
    if map_row["size_bytes"] + delta > MAX_MAP:
        raise map_too_large()
    updated = bump(conn, map_row, delta)
    conn.execute(
        "INSERT INTO documents (map_id, collection, doc_id, data, size_bytes, version) VALUES (%s, %s, %s, %s, %s, %s)"
        " ON CONFLICT (map_id, collection, doc_id) DO UPDATE SET data = EXCLUDED.data,"
        " size_bytes = EXCLUDED.size_bytes, version = EXCLUDED.version, updated_at = now()",
        (map_row["id"], collection, doc_id, Jsonb(data), size, updated["version"]),
    )
    return updated


def delete_document(conn, map_row: dict, collection: str, doc_id: str) -> dict:
    """Deletes one document and keeps a marker for polling. Deleting a missing document changes nothing."""
    old = conn.execute(
        "SELECT size_bytes FROM documents WHERE map_id = %s AND collection = %s AND doc_id = %s AND data IS NOT NULL",
        (map_row["id"], collection, doc_id),
    ).fetchone()
    if not old:
        return map_row
    updated = bump(conn, map_row, -old["size_bytes"])
    conn.execute(
        "UPDATE documents SET data = NULL, size_bytes = 0, version = %s, updated_at = now()"
        " WHERE map_id = %s AND collection = %s AND doc_id = %s",
        (updated["version"], map_row["id"], collection, doc_id),
    )
    return updated


def snapshot(conn) -> None:
    """Makes the transaction of conn read from one snapshot (REPEATABLE READ, finding B6 of the final review). Each read
    of the documents of a map reads the map and then its documents. Under READ COMMITTED, each statement sees the newest
    commits, so a write between the two gave new documents with the old version, and the next edit of the reader got a
    false 409 conflict. The call must be the first statement of the transaction. A transaction that only reads never
    fails at this level."""
    conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")


def read_documents(conn, map_row: dict, since: int | None) -> dict | None:
    """All documents of a map, or with since only the changes after that version. None means: no change. map_row and
    the documents must come from one snapshot: conn starts its transaction with snapshot()."""
    version = map_row["version"]
    if since is not None and since == version:
        return None
    delta = since is not None and 0 <= since < version
    if delta:
        rows = conn.execute(
            "SELECT collection, doc_id, data FROM documents WHERE map_id = %s AND version > %s"
            " ORDER BY collection, doc_id",
            (map_row["id"], since),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT collection, doc_id, data FROM documents WHERE map_id = %s AND data IS NOT NULL"
            " ORDER BY collection, doc_id",
            (map_row["id"],),
        ).fetchall()
    return {
        "version": version,
        "full": not delta,
        "docs": [{"collection": r["collection"], "id": r["doc_id"], "data": r["data"]}
                 for r in rows if r["data"] is not None],
        "deleted": [{"collection": r["collection"], "id": r["doc_id"]} for r in rows if r["data"] is None],
    }


def map_filename(map_row: dict) -> str:
    return f"{map_row['slug']}.json"


def export_map(conn, map_row: dict) -> dict:
    collections: dict = {}
    for row in conn.execute(
        "SELECT collection, doc_id, data FROM documents WHERE map_id = %s AND data IS NOT NULL"
        " ORDER BY collection, doc_id",
        (map_row["id"],),
    ):
        collections.setdefault(row["collection"], {})[row["doc_id"]] = row["data"]
    return {"format": FORMAT, "schema": SCHEMA, "title": map_row["title"], "exportedAt": now_iso(),
            "collections": collections}


def parse_map_file(file, language: str) -> tuple[str, dict, int]:
    """Checks a map file by the rules of selfhost/FORMAT.md, which the site applies too (parseFile in
    selfhost/runtime/local.js). Returns (title, collections, total size) or raises an ApiError. A file without a title,
    or with an empty one, gets the title of content.importedTitle in the language of the account that imports it."""
    if not isinstance(file, dict):
        raise ApiError(422, "invalid_map_file", "notObject")
    if file.get("format") != FORMAT:
        raise ApiError(422, "wrong_format", format=FORMAT)
    schema = file.get("schema")
    # A whole number, also when the file writes it as 1.0: JavaScript reads both as the same number.
    if isinstance(schema, float) and schema.is_integer():
        schema = int(schema)
    if not isinstance(schema, int) or isinstance(schema, bool) or schema < 1:
        raise ApiError(422, "invalid_map_file", "schema")
    if schema > SCHEMA:
        raise ApiError(422, "unsupported_schema")
    while schema < SCHEMA:
        file = SCHEMA_STEPS[schema](file)
        schema += 1
    collections = file.get("collections")
    if not isinstance(collections, dict):
        raise ApiError(422, "invalid_map_file", "noCollections")
    if "title" in file and not isinstance(file["title"], str):
        raise bad("invalid_title", max=MAX_TITLE)
    title = file_title(file.get("title", ""))
    if CONTROL.search(title) or SURROGATE.search(title):
        raise bad("invalid_title", max=MAX_TITLE)
    title = title or text(language, "content.importedTitle")
    total = 0
    for name, documents in collections.items():
        check_collection(name)
        if not isinstance(documents, dict):
            raise ApiError(422, "invalid_map_file", "collection", name=name)
        for doc_id, data in documents.items():
            check_doc_id(name, doc_id)
            total += document_size(data)
    if total > MAX_MAP:
        raise map_too_large()
    return title, collections, total


def import_documents(conn, map_row: dict, collections: dict) -> None:
    """Fills a new map with the documents of a map file, all at version 1."""
    with conn.cursor() as cursor:
        cursor.executemany(
            "INSERT INTO documents (map_id, collection, doc_id, data, size_bytes, version)"
            " VALUES (%s, %s, %s, %s, %s, %s)",
            [(map_row["id"], name, doc_id, Jsonb(data), document_size(data), map_row["version"])
             for name, documents in collections.items() for doc_id, data in documents.items()],
        )


def meta(map_row: dict, handle: str, settings, owner_view: bool) -> dict:
    """The description of a map. Readers get no id, no size and no embed setting. The view of a member
    (owner_view) also has the role of the visitor and the kind of the owner: "user" or "team". The embed
    address uses the handle of the owner, so a team map has /e/<team handle>/<slug>. A member gets the address on the
    subdomain of the owner for every visibility, as the dialog "Teilen" shows it before the map is public; a reader gets
    it only for a public map. The view of a member also names the address of the owner (ownerUrl) and whether the map is
    the start map that this address shows (start, migration 0007_start_map)."""
    page = settings.map_url(handle, map_row["slug"])
    site = settings.site_url(handle)
    public = map_row["visibility"] == "public"
    result = {
        "title": map_row["title"],
        "slug": map_row["slug"],
        "owner": handle,
        "visibility": map_row["visibility"],
        "version": map_row["version"],
        "created": iso(map_row["created_at"]),
        "updated": iso(map_row["updated_at"]),
        "pageUrl": page,
        "subdomainUrl": f"{site}/{map_row['slug']}" if site and (public or owner_view) else None,
    }
    if owner_view:
        embed = {"allow": map_row["embed_allow"], "origins": list(map_row["embed_origins"]),
                 "url": f"{settings.base_url}/e/{handle}/{map_row['slug']}" if public else None}
        result = {"id": str(map_row["id"]), **result, "size": map_row["size_bytes"], "embed": embed,
                  "ownerType": "team" if map_row.get("owner_kind") == "organization" else "user",
                  "role": map_row.get("role"), "ownerUrl": settings.owner_url(handle),
                  "start": bool(map_row.get("is_start"))}
    return result
