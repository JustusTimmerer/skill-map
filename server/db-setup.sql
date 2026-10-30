-- The role of the app, without admin rights (README.md, "Database roles").
--
-- The one-shot service db-setup of compose.yaml runs this file with psql as the admin role (POSTGRES_USER) on every start
-- of the stack: after db is healthy, and before app. Each run gives the same result, so it is safe to run it again.
--
-- 1. It creates the role POSTGRES_APP_USER, or updates it: LOGIN, the password POSTGRES_APP_PASSWORD, and no admin
--    right. The role is a member of no other role. When server/.env has no POSTGRES_APP_PASSWORD, the service db-setup
--    passes the random password that it keeps in its volume.
-- 2. It gives the role the database, the schema public, and every table, sequence and view in that schema. The app runs
--    the migrations at its start, so it must own the objects that they change. In a database of an older version, the
--    admin role owns every object. The first run moves them to the app role.
-- 3. It takes the right CONNECT on every other database (postgres, template1) from PUBLIC. So the app role reaches only
--    its own database. The admin role is a superuser and keeps its access.
--
-- Every value comes in as a psql variable: :'name' is a quoted literal, :"name" a quoted identifier. No value becomes
-- part of the SQL text in any other way.

\set ON_ERROR_STOP on
\set app_user ''
\set app_password ''
\getenv app_user POSTGRES_APP_USER
\getenv app_password POSTGRES_APP_PASSWORD

SELECT :'app_user' = '' OR :'app_password' = '' AS missing,
       :'app_user' = current_user AS is_admin,
       NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'app_user') AS create_role,
       current_database() AS database_name
\gset

\if :missing
DO $$ BEGIN RAISE EXCEPTION 'db-setup: POSTGRES_APP_USER and POSTGRES_APP_PASSWORD must not be empty'; END $$;
\endif
\if :is_admin
DO $$ BEGIN RAISE EXCEPTION 'db-setup: POSTGRES_APP_USER must name a role other than POSTGRES_USER'; END $$;
\endif

-- 1. The role.
\if :create_role
CREATE ROLE :"app_user";
\endif
ALTER ROLE :"app_user" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT
    CONNECTION LIMIT -1 PASSWORD :'app_password';

-- A membership in another role would give the app the rights of that role.
SELECT format('REVOKE %I FROM %I GRANTED BY %I', granted.rolname, :'app_user', grantor.rolname)
  FROM pg_auth_members m
  JOIN pg_roles granted ON granted.oid = m.roleid
  JOIN pg_roles grantor ON grantor.oid = m.grantor
 WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = :'app_user')
\gexec

-- 2. The database, the schema public and its objects. An index belongs to its table. A sequence of a serial or identity
-- column belongs to its table too and moves with it, so the list leaves it out.
ALTER DATABASE :"database_name" OWNER TO :"app_user";
ALTER SCHEMA public OWNER TO :"app_user";

SELECT format('ALTER %s %I.%I OWNER TO %I',
              CASE c.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,
              n.nspname, c.relname, :'app_user')
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
   AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = :'app_user')
   AND NOT (c.relkind = 'S' AND EXISTS (SELECT FROM pg_depend d
                                         WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                                           AND d.deptype IN ('a', 'i')))
 ORDER BY c.relkind = 'S', c.relname
\gexec

-- 3. The other databases. PostgreSQL gives CONNECT on each new database to PUBLIC, so every role could connect to them.
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', datname)
  FROM pg_database
 WHERE datname <> :'database_name' AND datallowconn
 ORDER BY datname
\gexec

SELECT format('db-setup: the role %s owns the database %s and its %s tables', :'app_user', :'database_name',
              count(*)) AS done
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
\gset
\echo :done
