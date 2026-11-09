-- Secure Guard legacy Source Inventory two-stage bootstrap: read-only final check.
-- Successful completion does not authorize LOGIN, credentials or Inventory.

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '3000ms';
SET LOCAL lock_timeout = '1000ms';
SET LOCAL idle_in_transaction_session_timeout = '10000ms';

DO $verify$
DECLARE
  reader constant text := 'sg_source_inventory_ro_20261106';
  owner_oid oid;
  reader_oid oid;
  password_is_null boolean;
BEGIN
  IF current_database() <> 'msp_customer_portal' THEN
    RAISE EXCEPTION 'STOP_FINAL_VERIFY: wrong Source Inventory database';
  END IF;
  IF current_setting('server_version_num')::integer NOT BETWEEN 160000 AND 169999 THEN
    RAISE EXCEPTION 'STOP_FINAL_VERIFY: expected PostgreSQL 16';
  END IF;
  SELECT c.relowner INTO owner_oid
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'schema_migrations'
    AND c.relkind IN ('r', 'p');
  IF pg_get_userbyid(owner_oid) IS DISTINCT FROM 'portal_app' THEN
    RAISE EXCEPTION 'STOP_FINAL_VERIFY: unexpected ledger owner';
  END IF;
  SELECT oid INTO reader_oid FROM pg_roles WHERE rolname = reader
    AND NOT rolcanlogin AND NOT rolsuper AND NOT rolinherit
    AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolreplication AND NOT rolbypassrls;
  IF reader_oid IS NULL THEN
    RAISE EXCEPTION 'STOP_FINAL_VERIFY: role state missing or invalid';
  END IF;
  BEGIN
    SELECT rolpassword IS NULL INTO password_is_null
    FROM pg_authid WHERE oid = reader_oid;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'STOP_FINAL_VERIFY: cannot verify PASSWORD NULL';
  END;
  IF password_is_null IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'STOP_FINAL_VERIFY: PASSWORD NULL contract violated';
  END IF;
  IF NOT has_database_privilege(reader, 'msp_customer_portal', 'CONNECT')
    OR NOT has_schema_privilege(reader, 'public', 'USAGE')
    OR NOT has_table_privilege(reader, 'public.schema_migrations', 'SELECT') THEN
    RAISE EXCEPTION 'STOP_FINAL_VERIFY: expected three grants missing';
  END IF;
  IF has_database_privilege(reader, 'msp_customer_portal', 'CREATE')
    OR EXISTS (SELECT 1 FROM pg_namespace n
      WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
        AND has_schema_privilege(reader, n.oid, 'CREATE'))
    OR has_table_privilege(reader, 'public.schema_migrations', 'INSERT')
    OR has_table_privilege(reader, 'public.schema_migrations', 'UPDATE')
    OR has_table_privilege(reader, 'public.schema_migrations', 'DELETE')
    OR has_table_privilege(reader, 'public.schema_migrations', 'TRUNCATE')
    OR EXISTS (SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p')
        AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
        AND NOT (n.nspname = 'public' AND c.relname = 'schema_migrations')
        AND (has_table_privilege(reader, c.oid, 'SELECT')
          OR has_table_privilege(reader, c.oid, 'INSERT')
          OR has_table_privilege(reader, c.oid, 'UPDATE')
          OR has_table_privilege(reader, c.oid, 'DELETE')
          OR has_table_privilege(reader, c.oid, 'TRUNCATE')))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = reader_oid) THEN
    RAISE EXCEPTION 'STOP_FINAL_VERIFY: unexpected effective privileges';
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
    RAISE EXCEPTION 'STOP_FINAL_VERIFY: SELECT was not granted by ledger owner';
  END IF;
END;
$verify$;

COMMIT;
