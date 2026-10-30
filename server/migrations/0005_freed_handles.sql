-- Freed handles. A handle is also a public address: /<handle> and /<handle>/<slug>, the embed view
-- /e/<handle>/<slug> in frames on other sites, and the subdomain <handle>.<domain>. When a team takes a new handle, or a
-- team or an account goes, its old handle stays blocked for HANDLE_HOLD_DAYS. So no stranger takes it and shows his
-- maps at the old addresses.
--
-- owner_id is the owner that held the handle. That owner may take the handle back, for example a team that renames
-- back. The column has no foreign key, because the owner of a deleted team or account no longer exists. An account
-- that nobody confirmed never had a public page, so its handle gets no row. The app deletes a row once its hold ends.

CREATE TABLE freed_handles (
    handle    text PRIMARY KEY,
    owner_id  uuid NOT NULL,
    freed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX freed_handles_age ON freed_handles (freed_at);
