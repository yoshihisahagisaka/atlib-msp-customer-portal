'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { Client } = require('pg');

// Disposable GitHub Actions PostgreSQL 16 ONLY: no GCP/production connections.
const fixturePassword = 'local_ci_fixture_password_not_a_secret';
const bootstrapSql = readFileSync(resolve(__dirname,
  '../../scripts/secureGuardSourceInventoryRoleBootstrap.sql'), 'utf8');
const base = {
  host: '127.0.0.1', port: 55432, user: 'postgres', password: fixturePassword,
  connectionTimeoutMillis: 3000,
};
const reader = 'sg_source_inventory_ro_20261106';
const executor = 'sg_bootstrap_executor';
const ledgerOwner = 'sg_bootstrap_ledger_owner';

async function aclSnapshot(client) {
  return (await client.query(`SELECT
    (SELECT datacl::text FROM pg_database WHERE datname=current_database()) AS database_acl,
    (SELECT nspacl::text FROM pg_namespace WHERE nspname='public') AS public_schema_acl,
    (SELECT relacl::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='schema_migrations') AS ledger_acl`)).rows[0];
}

async function configureGrantOptions(client, options) {
  await client.query(`
    REVOKE CONNECT ON DATABASE msp_customer_portal FROM ${executor};
    REVOKE USAGE ON SCHEMA public FROM ${executor};
    REVOKE SELECT ON TABLE public.schema_migrations FROM ${executor};
  `);
  if (options.connect) await client.query(
    `GRANT CONNECT ON DATABASE msp_customer_portal TO ${executor} WITH GRANT OPTION`);
  if (options.usage) await client.query(
    `GRANT USAGE ON SCHEMA public TO ${executor} WITH GRANT OPTION`);
  if (options.select) await client.query(
    `GRANT SELECT ON TABLE public.schema_migrations TO ${executor} WITH GRANT OPTION`);
}

test('PostgreSQL 16: non-superuser bootstrap requires all three grant options before DDL',
  { timeout: 30000 }, async () => {
    assert.equal(process.env.CI, 'true');
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(process.env.SECURE_GUARD_DB_E2E_ENABLED, 'true');
    assert.equal(process.env.SECURE_GUARD_DB_E2E_HOST, base.host);
    assert.equal(process.env.SECURE_GUARD_DB_E2E_PORT, String(base.port));

    const setup = new Client({ ...base, database: 'postgres' });
    await setup.connect();
    try {
      assert.equal((await setup.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [reader])).rowCount, 0);
      await setup.query(`CREATE ROLE ${ledgerOwner} NOLOGIN`);
      await setup.query(`CREATE ROLE ${executor} LOGIN CREATEROLE NOSUPERUSER
        NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${fixturePassword}'`);
      await setup.query('CREATE DATABASE msp_customer_portal');
    } finally { await setup.end(); }

    const executorConfig = { ...base, database: 'msp_customer_portal', user: executor };
    const wrongDb = new Client({ ...executorConfig, database: 'postgres' });
    await wrongDb.connect();
    try {
      await assert.rejects(wrongDb.query(bootstrapSql), /wrong Source Inventory database/);
      await wrongDb.query('ROLLBACK');
    } finally { await wrongDb.end(); }

    const admin = new Client({ ...base, database: 'msp_customer_portal' });
    const source = new Client(executorConfig);
    await admin.connect();
    await source.connect();
    try {
      const executorAttributes = (await admin.query(`SELECT rolsuper, rolcreaterole
        FROM pg_roles WHERE rolname=$1`, [executor])).rows[0];
      assert.deepEqual(executorAttributes, { rolsuper: false, rolcreaterole: true });

      // No ledger: even the correct database must abort before role creation.
      await assert.rejects(source.query(bootstrapSql), /legacy migration ledger absent/);
      await source.query('ROLLBACK');
      assert.equal((await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [reader])).rowCount, 0);

      await admin.query(`CREATE TABLE public.schema_migrations(filename text PRIMARY KEY)`);
      await admin.query(`ALTER TABLE public.schema_migrations OWNER TO ${ledgerOwner}`);
      await admin.query(`CREATE TABLE public.customer_organizations(id bigint PRIMARY KEY)`);
      await admin.query(`ALTER TABLE public.customer_organizations OWNER TO ${ledgerOwner}`);

      async function expectPreDdlStop(options, pattern) {
        await configureGrantOptions(admin, options);
        const beforeAcl = await aclSnapshot(admin);
        await assert.rejects(source.query(bootstrapSql), pattern);
        await source.query('ROLLBACK');
        assert.equal((await admin.query(
          'SELECT 1 FROM pg_roles WHERE rolname=$1', [reader])).rowCount, 0);
        assert.deepEqual(await aclSnapshot(admin), beforeAcl);
      }

      await expectPreDdlStop(
        { connect: false, usage: false, select: false },
        /CONNECT grant option missing/);
      await expectPreDdlStop(
        { connect: true, usage: false, select: false },
        /USAGE grant option missing/);
      await expectPreDdlStop(
        { connect: true, usage: true, select: false },
        /ledger SELECT grant option missing/);

      await configureGrantOptions(admin, { connect: true, usage: true, select: true });
      await source.query(bootstrapSql);

      const role = (await admin.query(`SELECT rolcanlogin, rolsuper, rolinherit,
        rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
        FROM pg_roles WHERE rolname = $1`, [reader])).rows[0];
      assert.ok(role);
      assert.ok(Object.values(role).every((value) => value === false));

      const grants = (await admin.query(`SELECT
        has_database_privilege($1, current_database(), 'CONNECT') AS db_connect,
        has_database_privilege($1, current_database(), 'CREATE') AS db_create,
        has_schema_privilege($1, 'public', 'USAGE') AS public_usage,
        has_schema_privilege($1, 'public', 'CREATE') AS public_create,
        has_table_privilege($1, 'public.schema_migrations', 'SELECT') AS ledger_read,
        has_table_privilege($1, 'public.schema_migrations', 'INSERT') AS ledger_write,
        has_table_privilege($1, 'public.customer_organizations', 'SELECT') AS business_read,
        has_table_privilege($1, 'public.customer_organizations', 'INSERT') AS business_write`, [reader])).rows[0];
      assert.deepEqual(grants, {
        db_connect: true, db_create: false,
        public_usage: true, public_create: false,
        ledger_read: true, ledger_write: false,
        business_read: false, business_write: false,
      });

      // PostgreSQL 16 can give a CREATEROLE executor management membership in
      // the role it creates. That reverse direction must not make the reader a
      // member of the executor (or of any other role).
      assert.equal((await admin.query(`SELECT 1 FROM pg_auth_members
        WHERE member=(SELECT oid FROM pg_roles WHERE rolname=$1)`, [reader])).rowCount, 0);
      const creatorManagement = (await admin.query(`SELECT admin_option
        FROM pg_auth_members
        WHERE roleid=(SELECT oid FROM pg_roles WHERE rolname=$1)
          AND member=(SELECT oid FROM pg_roles WHERE rolname=$2)`,
      [reader, executor])).rows;
      assert.ok(creatorManagement.length <= 1);
      if (creatorManagement.length === 1) assert.equal(creatorManagement[0].admin_option, true);

      // Never silently reuse or extend an existing cluster-wide role.
      await assert.rejects(source.query(bootstrapSql), /source inventory role already exists/);
      await source.query('ROLLBACK');
      const roleAfter = (await admin.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1', [reader])).rows[0];
      assert.equal(roleAfter.rolcanlogin, false);
    } finally {
      await source.end();
      await admin.end();
    }

    const cleanup = new Client({ ...base, database: 'postgres' });
    await cleanup.connect();
    try {
      await cleanup.query('DROP DATABASE msp_customer_portal WITH (FORCE)');
      await cleanup.query(`DROP ROLE ${reader}`);
      await cleanup.query(`DROP ROLE ${executor}`);
      await cleanup.query(`DROP ROLE ${ledgerOwner}`);
    } finally { await cleanup.end(); }
  });
