-- Secure Guard legacy Source Inventory two-stage bootstrap: Stage A only.
-- Creates a fail-closed NOLOGIN role with database CONNECT and schema USAGE.
-- This script does not grant ledger access, enable LOGIN or run Inventory.

BEGIN;
SET LOCAL statement_timeout = '3000ms';
SET LOCAL lock_timeout = '1000ms';
SET LOCAL idle_in_transaction_session_timeout = '10000ms';

DO $gate$
DECLARE
  reader constant text := 'sg_source_inventory_ro_20261106';
  used_connections integer;
  max_connections integer;
BEGIN
  IF current_database() <> 'msp_customer_portal' THEN
    RAISE EXCEPTION 'STOP_STAGE_A: wrong Source Inventory database';
  END IF;
  IF current_setting('server_version_num')::integer NOT BETWEEN 160000 AND 169999 THEN
    RAISE EXCEPTION 'STOP_STAGE_A: expected PostgreSQL 16';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'schema_migrations'
      AND c.relkind IN ('r', 'p')
      AND pg_get_userbyid(c.relowner) = 'portal_app'
  ) THEN
    RAISE EXCEPTION 'STOP_STAGE_A: expected portal_app-owned ledger absent';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = reader) THEN
    RAISE EXCEPTION 'STOP_STAGE_A: source inventory role already exists';
  END IF;
  IF NOT has_database_privilege(
    current_user, 'msp_customer_portal', 'CONNECT WITH GRANT OPTION') THEN
    RAISE EXCEPTION 'STOP_STAGE_A: CONNECT grant option missing';
  END IF;
  IF NOT has_schema_privilege(
    current_user, 'public', 'USAGE WITH GRANT OPTION') THEN
    RAISE EXCEPTION 'STOP_STAGE_A: USAGE grant option missing';
  END IF;

  SELECT count(*)::integer INTO used_connections
    FROM pg_stat_activity WHERE backend_type = 'client backend';
  max_connections := current_setting('max_connections')::integer;
  IF used_connections >= LEAST(20, floor(max_connections * 0.8)::integer) THEN
    RAISE EXCEPTION 'STOP_STAGE_A: insufficient production connection headroom';
  END IF;
END;
$gate$;

CREATE ROLE sg_source_inventory_ro_20261106 WITH
  NOLOGIN NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS PASSWORD NULL;

GRANT CONNECT ON DATABASE msp_customer_portal
  TO sg_source_inventory_ro_20261106;
GRANT USAGE ON SCHEMA public TO sg_source_inventory_ro_20261106;

DO $verify$
DECLARE
  reader constant text := 'sg_source_inventory_ro_20261106';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = reader
      AND NOT rolcanlogin AND NOT rolsuper AND NOT rolinherit
      AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'STOP_STAGE_A: role attributes violate NOLOGIN contract';
  END IF;
  IF NOT has_database_privilege(reader, 'msp_customer_portal', 'CONNECT')
    OR NOT has_schema_privilege(reader, 'public', 'USAGE') THEN
    RAISE EXCEPTION 'STOP_STAGE_A: expected base grants missing';
  END IF;
  IF has_database_privilege(reader, 'msp_customer_portal', 'CREATE')
    OR has_table_privilege(reader, 'public.schema_migrations', 'SELECT')
    OR EXISTS (SELECT 1 FROM pg_namespace n
      WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
        AND has_schema_privilege(reader, n.oid, 'CREATE'))
    OR EXISTS (SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p')
        AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
        AND (has_table_privilege(reader, c.oid, 'SELECT')
          OR has_table_privilege(reader, c.oid, 'INSERT')
          OR has_table_privilege(reader, c.oid, 'UPDATE')
          OR has_table_privilege(reader, c.oid, 'DELETE')
          OR has_table_privilege(reader, c.oid, 'TRUNCATE')))
    OR EXISTS (SELECT 1 FROM pg_auth_members
      WHERE member = (SELECT oid FROM pg_roles WHERE rolname = reader)) THEN
    RAISE EXCEPTION 'STOP_STAGE_A: source inventory role has unexpected privileges';
  END IF;
END;
$verify$;

COMMIT;
