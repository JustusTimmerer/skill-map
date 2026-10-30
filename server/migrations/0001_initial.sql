-- Stage b: accounts, sessions, maps as a document store, share links and rate limits.
--
-- Owners: every map belongs to an owner, not directly to a user. Today an owner is always a user
-- (kind 'user', same id as the row in users). Stage c adds organizations as a second kind of owner:
-- a table organizations (id REFERENCES owners) and a table memberships (organization, user, role
-- owner/editor/reader). Maps, share links and the public pages then need no change, because they
-- only know owners. The handle of an owner is its public name in /<handle> and <handle>.<domain>.

CREATE TABLE owners (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind        text NOT NULL CHECK (kind IN ('user')),
    handle      text NOT NULL UNIQUE CHECK (handle ~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$'),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id                   uuid PRIMARY KEY REFERENCES owners (id) ON DELETE CASCADE,
    email                text NOT NULL,
    password_hash        text NOT NULL,
    confirmed_at         timestamptz,
    password_changed_at  timestamptz NOT NULL DEFAULT now(),
    created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

-- One-time tokens sent by e-mail. Only the SHA-256 hash of a token is stored.
CREATE TABLE email_tokens (
    token_hash  bytea PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    purpose     text NOT NULL CHECK (purpose IN ('confirm', 'reset')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz
);
CREATE INDEX email_tokens_user ON email_tokens (user_id, purpose);

-- Server-side sessions. The cookie holds a random id; the table holds only its SHA-256 hash.
CREATE TABLE sessions (
    id_hash       bytea PRIMARY KEY,
    user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expiry ON sessions (expires_at);

-- A map. version rises with every write; size_bytes is the sum of the sizes of its live documents.
CREATE TABLE maps (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id    uuid NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
    title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    slug        text NOT NULL CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$'),
    visibility  text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'link', 'public')),
    version     bigint NOT NULL DEFAULT 1,
    size_bytes  bigint NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_id, slug)
);
CREATE INDEX maps_public ON maps (owner_id) WHERE visibility = 'public';

-- The documents of a map, one row per collection and document id, as on the page interface.
-- A deleted document keeps its row with data NULL, so that polling with ?since=<version> can report
-- the delete. version is the map version of the last write of the row.
CREATE TABLE documents (
    map_id      uuid NOT NULL REFERENCES maps (id) ON DELETE CASCADE,
    collection  text NOT NULL CHECK (collection ~ '^[a-z][a-z0-9_-]{0,40}$'),
    doc_id      text NOT NULL CHECK (length(doc_id) BETWEEN 1 AND 200 AND strpos(doc_id, '/') = 0),
    data        jsonb,
    size_bytes  integer NOT NULL DEFAULT 0,
    version     bigint NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (map_id, collection, doc_id)
);
CREATE INDEX documents_changes ON documents (map_id, version);

-- Read-only share links. Only the SHA-256 hash of the token is stored; the owner sees the token once.
CREATE TABLE share_links (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    map_id      uuid NOT NULL REFERENCES maps (id) ON DELETE CASCADE,
    token_hash  bytea NOT NULL UNIQUE,
    created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX share_links_map ON share_links (map_id);

-- Fixed-window counters for login, register and reset. key is a SHA-256 hash of the IP or e-mail.
CREATE TABLE rate_limits (
    bucket        text NOT NULL,
    key           text NOT NULL,
    window_start  timestamptz NOT NULL,
    hits          integer NOT NULL,
    PRIMARY KEY (bucket, key, window_start)
);
CREATE INDEX rate_limits_age ON rate_limits (window_start);
