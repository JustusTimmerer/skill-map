-- The language of each account: the language of its mails, and the language that its pages show.
--
-- A registration names it, and PATCH /api/account changes it. The app accepts only the languages of its catalogs
-- (server/app/i18n/<language>/), so the check here only keeps the form of a language code. Every account of the time
-- before this migration gets English, the language of a first visit.

ALTER TABLE users ADD COLUMN language text NOT NULL DEFAULT 'en'
    CHECK (language ~ '^[a-z]{2,3}(-[A-Z]{2})?$');
