-- The start map of an owner: the map that the address of the owner shows, <BASE_URL>/<handle>, and the root of its
-- subdomain <handle>.<BASE_DOMAIN>.
--
-- His answer of 2026-10-19 (finding A5 of the final review): the main addresses are paths below the main domain,
-- <BASE_URL>/<handle> for the "default map" and <BASE_URL>/<handle>/<slug> for each map. An owner (a user or a team)
-- has at most one start map. The address shows it while it is public, and else the list of the public maps.
--
-- The column has no check that the map belongs to the owner, because a move into a team changes the owner of a map.
-- The app clears the column of the old owner at the move, and it reads a start map only together with its owner
-- (access.public_start_map). A deleted map clears the column through ON DELETE SET NULL. The index serves that clear,
-- so the delete of a map does not read every owner.

ALTER TABLE owners ADD COLUMN start_map_id uuid REFERENCES maps (id) ON DELETE SET NULL;
CREATE INDEX owners_start_map ON owners (start_map_id) WHERE start_map_id IS NOT NULL;
