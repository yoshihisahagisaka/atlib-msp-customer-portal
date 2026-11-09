'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { Client } = require('pg');

const fixturePassword = 'local_ci_fixture_password_not_a_secret';
const stageA = readFileSync(resolve(__dirname,
  '../../scripts/secureGuardSourceInventoryRoleStageA.sql'), 'utf8');
const stageB = readFileSync(resolve(__dirname,
  '../../scripts/secureGuardSourceInventoryRoleStageB.sql'), 'utf8');
const finalVerify = readFileSync(resolve(__dirname,
  '../../scripts/secureGuardSourceInventoryRoleFinalVerify.sql'), 'utf8');
const base = {
  host: '127.0.0.1', port: 55432, user: 'postgres', password: fixturePassword,
  connectionTimeoutMillis: 3000,
};
const reader = 'sg_source_inventory_ro_20261106';
const executor = 'sg_stage_a_executor';
const owner = 'portal_app';

async function roleState(client) {
  return (await client.query(`SELECT rolcanlogin,
    has_database_privilege($1, current_database(), 'CONNECT') AS db_connect,
    has_schema_privilege($1, 'public', 'USAGE') AS schema_usage,
    has_table_privilege($1, 'public.schema_migrations', 'SELECT') AS ledger_select,
    has_table_privilege($1, 'public.schema_migrations', 'INSERT') AS ledger_insert,
    has_table_privilege($1, 'public.customer_organizations', 'SELECT') AS business_select
    FROM pg_roles WHERE rolname=$1`, [reader])).rows[0];
}

test('PostgreSQL 16: two-stage Source Inventory bootstrap is fail-closed and recoverable',
  { timeout: 30000 }, async () => {
    assert.equal(process.env.CI, 'true');
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(process.env.SECURE_GUARD_DB_E2E_ENABLED, 'true');
    assert.equal(process.env.SECURE_GUARD_DB_E2E_HOST, base.host);
    assert.equal(process.env.SECURE_GUARD_DB_E2E_PORT, String(base.port));

    const setup = new Client({ ...base, database: 'postgres' });
    await setup.connect();
    try {
      await setup.query(`CREATE ROLE ${owner} LOGIN PASSWORD '${fixturePassword}'`);
      await setup.query(`CREATE ROLE ${executor} LOGIN CREATEROLE NOSUPERUSER
        NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${fixturePassword}'`);
      await setup.query('CREATE DATABASE msp_customer_portal');
    } finally { await setup.end(); }

    const admin = new Client({ ...base, database: 'msp_customer_portal' });
    const stageAActor = new Client({ ...base, database: 'msp_customer_portal', user: executor });
    const stageBActor = new Client({ ...base, database: 'msp_customer_portal', user: owner });
    await admin.connect();
    await stageAActor.connect();
    await stageBActor.connect();
    try {
      await admin.query(`CREATE TABLE public.schema_migrations(filename text PRIMARY KEY)`);
      await admin.query(`ALTER TABLE public.schema_migrations OWNER TO ${owner}`);
      await admin.query(`CREATE TABLE public.customer_organizations(id bigint PRIMARY KEY)`);
      await admin.query(`ALTER TABLE public.customer_organizations OWNER TO ${owner}`);
      await admin.query(`GRANT CONNECT ON DATABASE msp_customer_portal
        TO ${executor} WITH GRANT OPTION`);
      await admin.query(`GRANT USAGE ON SCHEMA public
        TO ${executor} WITH GRANT OPTION`);

      // A post-DDL verification failure must roll back role creation and grants.
      await admin.query('GRANT SELECT ON public.customer_organizations TO PUBLIC');
      await assert.rejects(stageAActor.query(stageA), /STOP_STAGE_A: source inventory role has unexpected privileges/);
      await stageAActor.query('ROLLBACK');
      assert.equal((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [reader])).rowCount, 0);
      await admin.query('REVOKE SELECT ON public.customer_organizations FROM PUBLIC');

      await stageAActor.query(stageA);
      assert.deepEqual(await roleState(admin), {
        rolcanlogin: false,
        db_connect: true,
        schema_usage: true,
        ledger_select: false,
        ledger_insert: false,
        business_select: false,
      });

      // Stage A interruption remains NOLOGIN and cannot read the ledger.
      await assert.rejects(stageAActor.query(stageA), /STOP_STAGE_A: source inventory role already exists/);
      await stageAActor.query('ROLLBACK');

      // An executor with grant power but not ownership is rejected explicitly.
      await assert.rejects(admin.query(stageB), /STOP_STAGE_B: executor is not the approved ledger owner/);
      await admin.query('ROLLBACK');
      // The Stage A actor is rejected earlier because it lacks ledger grant option.
      await assert.rejects(stageAActor.query(stageB), /STOP_STAGE_B: ledger SELECT grant option missing/);
      await stageAActor.query('ROLLBACK');

      // A transaction failure after the GRANT preserves the committed Stage A state.
      await stageBActor.query('BEGIN');
      await stageBActor.query(`GRANT SELECT ON public.schema_migrations TO ${reader}`);
      await stageBActor.query('ROLLBACK');
      assert.equal((await roleState(admin)).ledger_select, false);

      await stageBActor.query(stageB);
      assert.deepEqual(await roleState(admin), {
        rolcanlogin: false,
        db_connect: true,
        schema_usage: true,
        ledger_select: true,
        ledger_insert: false,
        business_select: false,
      });

      // An unknown result is inspected, never auto-granted again.
      await assert.rejects(stageBActor.query(stageB), /STOP_STAGE_B: ledger SELECT already present; inspect before retry/);
      await stageBActor.query('ROLLBACK');
      await admin.query(finalVerify);

      // Final verification fails closed on any unexpected business-table access.
      await admin.query(`GRANT SELECT ON public.customer_organizations TO ${reader}`);
      await assert.rejects(admin.query(finalVerify), /STOP_FINAL_VERIFY: unexpected effective privileges/);
      await admin.query('ROLLBACK');
      await admin.query(`REVOKE SELECT ON public.customer_organizations FROM ${reader}`);
      await admin.query(finalVerify);

      // Recovery is deliberately actor-separated and performed in reverse order.
      await stageBActor.query(`REVOKE SELECT ON public.schema_migrations FROM ${reader}`);
      await stageAActor.query(`REVOKE USAGE ON SCHEMA public FROM ${reader}`);
      await stageAActor.query(`REVOKE CONNECT ON DATABASE msp_customer_portal FROM ${reader}`);
      const dependencies = (await admin.query(`SELECT
        has_database_privilege($1, current_database(), 'CONNECT') AS db_connect,
        has_schema_privilege($1, 'public', 'USAGE') AS schema_usage,
        has_table_privilege($1, 'public.schema_migrations', 'SELECT') AS ledger_select`,
      [reader])).rows[0];
      assert.deepEqual(dependencies, { db_connect: true, schema_usage: true, ledger_select: false });
      // CONNECT/USAGE remain true through PUBLIC; no explicit ACL dependency remains.
      const explicitAcl = (await admin.query(`SELECT count(*)::integer AS count FROM (
        SELECT acl.grantee FROM pg_database d
          CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) acl
          WHERE d.datname=current_database()
        UNION ALL
        SELECT acl.grantee FROM pg_namespace n
          CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) acl
          WHERE n.nspname='public'
        UNION ALL
        SELECT acl.grantee FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
          WHERE n.nspname='public' AND c.relname='schema_migrations'
      ) grants WHERE grantee=(SELECT oid FROM pg_roles WHERE rolname=$1)`, [reader])).rows[0];
      assert.equal(explicitAcl.count, 0);
      await stageAActor.query(`DROP ROLE ${reader}`);
      assert.equal((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [reader])).rowCount, 0);
    } finally {
      await stageBActor.end();
      await stageAActor.end();
      await admin.end();
    }
  });
