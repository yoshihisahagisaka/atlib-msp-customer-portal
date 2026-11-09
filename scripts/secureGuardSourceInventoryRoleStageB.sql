-- Secure Guard legacy Source Inventory two-stage bootstrap: Stage B only.
-- Must be run by the verified owner of public.schema_migrations.

BEGIN;
SET LOCAL statement_timeout = '3000ms';
SET LOCAL lock_timeout = '1000ms';
SET LOCAL idle_in_transaction_session_timeout = '10000ms';

DO $gate$
DECLARE
  reader constant text := 'sg_source_inventory_ro_20261106';
  ledger_owner text;
BEGIN
  IF current_database() <> 'msp_customer_portal' THEN
    RAISE EXCEPTION 'STOP_STAGE_B: wrong Source Inventory database';
  END IF;
  IF current_setting('server_version_num')::integer NOT BETWEEN 160000 AND 169999 THEN
    RAISE EXCEPTION 'STOP_STAGE_B: expected PostgreSQL 16';
  END IF;
  SELECT pg_get_userbyid(c.relowner) INTO ledger_owner
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'schema_migrations'
    AND c.relkind IN ('r', 'p');
  IF ledger_owner IS DISTINCT FROM 'portal_app' THEN
    RAISE EXCEPTION 'STOP_STAGE_B: unexpected ledger owner';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = reader
      AND NOT rolcanlogin AND NOT rolsuper AND NOT rolinherit
      AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'STOP_STAGE_B: Stage A role state missing or invalid';
  END IF;
  IF NOT has_database_privilege(reader, 'msp_customer_portal', 'CONNECT')
    OR NOT has_schema_privilege(reader, 'public', 'USAGE') THEN
    RAISE EXCEPTION 'STOP_STAGE_B: Stage A grants missing';
  END IF;
  IF has_table_privilege(reader, 'public.schema_migrations', 'SELECT') THEN
    RAISE EXCEPTION 'STOP_STAGE_B: ledger SELECT already present; inspect before retry';
  END IF;
  IF NOT has_table_privilege(
    current_user, 'public.schema_migrations', 'SELECT WITH GRANT OPTION') THEN
    RAISE EXCEPTION 'STOP_STAGE_B: ledger SELECT grant option missing';
  END IF;
  IF current_user <> ledger_owner THEN
    RAISE EXCEPTION 'STOP_STAGE_B: executor is not the approved ledger owner';
  END IF;
  IF has_database_privilege(reader, 'msp_customer_portal', 'CREATE')
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
    RAISE EXCEPTION 'STOP_STAGE_B: Stage A role has unexpected privileges';
  END IF;
END;
$gate$;

GRANT SELECT ON TABLE public.schema_migrations
  TO sg_source_inventory_ro_20261106;

DO $verify$
DECLARE
  reader constant text := 'sg_source_inventory_ro_20261106';
  owner_oid oid := (SELECT oid FROM pg_roles WHERE rolname = 'portal_app');
  reader_oid oid := (SELECT oid FROM pg_roles WHERE rolname = reader);
BEGIN
  IF NOT has_table_privilege(reader, 'public.schema_migrations', 'SELECT')
    OR has_table_privilege(reader, 'public.schema_migrations', 'INSERT')
    OR has_table_privilege(reader, 'public.schema_migrations', 'UPDATE')
    OR has_table_privilege(reader, 'public.schema_migrations', 'DELETE')
    OR has_table_privilege(reader, 'public.schema_migrations', 'TRUNCATE') THEN
    RAISE EXCEPTION 'STOP_STAGE_B: ledger privilege verification failed';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(
      COALESCE(c.relacl, acldefault('r', c.relowner))) acl
    WHERE n.nspname = 'public' AND c.relname = 'schema_migrations'
      AND acl.grantee = reader_oid AND acl.grantor = owner_oid
      AND acl.privilege_type = 'SELECT' AND NOT acl.is_grantable
  ) THEN
    RAISE EXCEPTION 'STOP_STAGE_B: expected owner-granted SELECT ACL absent';
  END IF;
END;
$verify$;

COMMIT;
