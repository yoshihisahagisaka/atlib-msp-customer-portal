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

test('PostgreSQL 16: Source Inventory role bootstrap is atomic, bounded and NOLOGIN',
  { timeout: 30000 }, async () => {
    assert.equal(process.env.CI, 'true');
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(process.env.SECURE_GUARD_DB_E2E_ENABLED, 'true');
    assert.equal(process.env.SECURE_GUARD_DB_E2E_HOST, base.host);
    assert.equal(process.env.SECURE_GUARD_DB_E2E_PORT, String(base.port));

    // Refuse the incorrect database before creating even a cluster-wide role.
    const wrongDb = new Client({ ...base, database: 'postgres' });
    await wrongDb.connect();
    try {
      await assert.rejects(wrongDb.query(bootstrapSql), /wrong Source Inventory database/);
    } finally { await wrongDb.end(); }

    const setup = new Client({ ...base, database: 'postgres' });
    await setup.connect();
    try {
      assert.equal((await setup.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [reader])).rowCount, 0);
      await setup.query('CREATE DATABASE msp_customer_portal');
    } finally { await setup.end(); }

    const source = new Client({ ...base, database: 'msp_customer_portal' });
    await source.connect();
    try {
      // No ledger: even the correct database must abort before role creation.
      await assert.rejects(source.query(bootstrapSql), /legacy migration ledger absent/);
      await source.query('ROLLBACK');
      assert.equal((await source.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [reader])).rowCount, 0);

      await source.query('CREATE TABLE public.schema_migrations(filename text PRIMARY KEY)');
      await source.query('CREATE TABLE public.customer_organizations(id bigint PRIMARY KEY)');
      await source.query(bootstrapSql);

      const role = (await source.query(`SELECT rolcanlogin, rolsuper, rolinherit,
        rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
        FROM pg_roles WHERE rolname = $1`, [reader])).rows[0];
      assert.ok(role);
      assert.ok(Object.values(role).every((value) => value === false));

      const grants = (await source.query(`SELECT
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

      // Never silently reuse or extend an existing cluster-wide role.
      await assert.rejects(source.query(bootstrapSql), /source inventory role already exists/);
      await source.query('ROLLBACK');
      const roleAfter = (await source.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1', [reader])).rows[0];
      assert.equal(roleAfter.rolcanlogin, false);
    } finally { await source.end(); }
  });
