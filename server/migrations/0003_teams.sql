-- Stage c: teams (organizations) as a second kind of owner, their members with a role, and invitations.
--
-- A team is an owner of kind 'organization'. It shares the handle namespace with the users, because a
-- handle is also a top-level path and a subdomain. Maps, documents and share links need no change: a map
-- already points to an owner. The migration only adds tables and widens one check, so the data of
-- stage b stays as it is.

ALTER TABLE owners DROP CONSTRAINT owners_kind_check;
ALTER TABLE owners ADD CONSTRAINT owners_kind_check CHECK (kind IN ('user', 'organization'));

CREATE TABLE organizations (
    id          uuid PRIMARY KEY REFERENCES owners (id) ON DELETE CASCADE,
    name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- The members of a team. A team always keeps at least one owner; the app checks it under a row lock on
-- the team (SELECT ... FOR UPDATE on organizations).
CREATE TABLE memberships (
    organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role             text NOT NULL CHECK (role IN ('owner', 'editor', 'reader')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX memberships_user ON memberships (user_id);

-- Invitations by e-mail. Only the SHA-256 hash of the token is stored. An invitation is open while
-- accepted_at is NULL and expires_at lies in the future. Any signed-in account can accept it once.
CREATE TABLE invitations (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    email            text NOT NULL,
    role             text NOT NULL CHECK (role IN ('owner', 'editor', 'reader')),
    token_hash       bytea NOT NULL UNIQUE,
    invited_by       uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    expires_at       timestamptz NOT NULL,
    accepted_at      timestamptz,
    accepted_by      uuid REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX invitations_team ON invitations (organization_id, lower(email));

CREATE INDEX maps_created_by ON maps (created_by);
