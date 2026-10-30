-- Embedding: who may show the embed view of a map (/e/<handle>/<slug> and /e/s/<token>) in a frame.
-- embed_allow 'all' lets every site frame it. 'origins' lets only the sites in embed_origins frame it, and the site
-- itself. The list stays when the owner switches back to 'all', so that a second switch does not lose it.
-- The app checks and normalizes each origin (store.check_origin), because the values go into a
-- Content-Security-Policy header.
ALTER TABLE maps
    ADD COLUMN embed_allow text NOT NULL DEFAULT 'all' CHECK (embed_allow IN ('all', 'origins')),
    ADD COLUMN embed_origins text[] NOT NULL DEFAULT '{}' CHECK (cardinality(embed_origins) <= 20);
