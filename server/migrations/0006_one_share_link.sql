-- One read link per map, which its owner can copy again at any time.
--
-- His decision of 2026-10-19 (finding A3 of the final review): a map has at most one read link. The owner sees it in
-- "Share" and on the account page at any time and copies it again. To end it, the owner revokes it and gets a new
-- one in the same step (POST /api/maps/{id}/shares). A private map still pauses its link.
--
-- token holds the token, so that the server can show the link to the owner again. token_hash stays the key of the
-- lookup for a reader (access.shared_map). Before this migration the server kept only the hash, so no old link has a
-- token, and the migration deletes every link without one. No release had such links, only test stacks. Their owners
-- create a new link.
--
-- The unique index on map_id keeps one link per map, also for two requests at the same moment. A later migration can
-- add a column mode, for example for an edit link, and widen the index to (map_id, mode).

ALTER TABLE share_links ADD COLUMN token text;
DELETE FROM share_links WHERE token IS NULL;
ALTER TABLE share_links ALTER COLUMN token SET NOT NULL;

DROP INDEX share_links_map;
CREATE UNIQUE INDEX share_links_one_per_map ON share_links (map_id);
