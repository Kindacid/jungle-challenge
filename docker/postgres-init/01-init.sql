-- Runs once, as the postgres superuser, inside the POSTGRES_DB (= wagering).
-- Creates the owner and restricted app roles and hands schema ownership to the
-- owner. Migrations run as wagering_owner; the application runs as wagering_app.
--
-- NOTE: these are LOCAL DEVELOPMENT credentials only. Override via environment
-- in any shared or production environment.

CREATE ROLE wagering_owner LOGIN PASSWORD 'wagering_owner_pwd';
CREATE ROLE wagering_app   LOGIN PASSWORD 'wagering_app_pwd';

GRANT CONNECT ON DATABASE wagering TO wagering_owner, wagering_app;

-- Let the owner role own and create objects in the public schema (PG15+ no
-- longer grants CREATE on public to everyone).
ALTER SCHEMA public OWNER TO wagering_owner;
GRANT USAGE ON SCHEMA public TO wagering_app;
