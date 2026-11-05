'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { readSettings, connectionGate, collectInventory } = require('../../scripts/secureGuardSourceInventoryReadOnly.cjs');

const host = '127.0.0.1';
const port = 55432;
const fixturePassword = 'local_ci_fixture_password_not_a_secret';

test('source inventory requires explicit approval, expected DB and loopback proxy', () => {
  const base = {
    SECURE_GUARD_SOURCE_INVENTORY_APPROVED: 'true',
    SECURE_GUARD_SOURCE_DB_HOST: host,
    SECURE_GUARD_SOURCE_DB_NAME: 'expected_legacy',
    SECURE_GUARD_SOURCE_EXPECTED_DB_NAME: 'expected_legacy',
    SECURE_GUARD_SOURCE_DB_USER: 'readonly',
    SECURE_GUARD_SOURCE_DB_PASSWORD: fixturePassword,
  };
  assert.throws(() => readSettings({ ...base, SECURE_GUARD_SOURCE_INVENTORY_APPROVED: undefined }), /approval/);
  assert.throws(() => readSettings({ ...base, SECURE_GUARD_SOURCE_EXPECTED_DB_NAME: 'different' }), /identity/);
  assert.throws(() => readSettings({ ...base, SECURE_GUARD_SOURCE_DB_HOST: 'public.example.invalid' }), /loopback/);
  assert.throws(() => readSettings({ ...base, SECURE_GUARD_SOURCE_DB_PASSWORD: undefined }), /PASSWORD/);
  assert.throws(() => readSettings({ ...base, SECURE_GUARD_SOURCE_DB_SOCKET_PATH: '/cloudsql/test' }), /one source/);
  assert.equal(readSettings(base).connectionTimeoutMillis, 3000);
});

test('source connection headroom gate conservatively protects legacy max-25 instance', () => {
  assert.equal(connectionGate(19, 25), true);
  assert.equal(connectionGate(20, 25), false);
  assert.equal(connectionGate(22, 25), false);
  assert.equal(connectionGate(79, 100), false);
  assert.equal(connectionGate(15, 18), false);
});

test('PostgreSQL 16: source inventory emits metadata only and never needs Portal secrets',
  { timeout: 30000 }, async () => {
    assert.equal(process.env.CI, 'true');
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(process.env.SECURE_GUARD_DB_E2E_ENABLED, 'true');
    assert.equal(process.env.SECURE_GUARD_DB_E2E_HOST, host);
    assert.equal(process.env.SECURE_GUARD_DB_E2E_PORT, String(port));

    const database = 'secure_guard_source_inventory_ci';
    const readerRole = 'secure_guard_source_read_ci';
    const admin = new Client({ host, port, user: 'postgres', database: 'postgres', password: fixturePassword });
    await admin.connect();
    try {
      await admin.query(`CREATE ROLE ${readerRole} LOGIN PASSWORD '${fixturePassword}'`);
      await admin.query(`CREATE DATABASE ${database}`);
      await admin.query(`REVOKE CONNECT ON DATABASE ${database} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${database} TO ${readerRole}`);
    } finally { await admin.end(); }

    const owner = new Client({ host, port, user: 'postgres', database, password: fixturePassword });
    await owner.connect();
    try {
      await owner.query('CREATE TABLE schema_migrations (filename text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
      await owner.query("INSERT INTO schema_migrations(filename) VALUES ('011_secure_guard_identity_scope.sql'), ('012_secure_guard_organization_independence.sql')");
      await owner.query('CREATE TABLE customer_organizations(id bigint PRIMARY KEY, organization_name text NOT NULL)');
      await owner.query("INSERT INTO customer_organizations VALUES (1, 'SYNTHETIC_PRIVATE_CUSTOMER')");
      await owner.query('CREATE TABLE customer_memberships(id bigint PRIMARY KEY, customer_organization_id bigint REFERENCES customer_organizations(id))');
      await owner.query(`GRANT USAGE ON SCHEMA public TO ${readerRole}`);
      await owner.query(`GRANT SELECT ON schema_migrations TO ${readerRole}`);
    } finally { await owner.end(); }

    const reader = new Client(readSettings({
      SECURE_GUARD_SOURCE_INVENTORY_APPROVED: 'true',
      SECURE_GUARD_SOURCE_DB_HOST: host,
      SECURE_GUARD_SOURCE_DB_PORT: String(port),
      SECURE_GUARD_SOURCE_DB_NAME: database,
      SECURE_GUARD_SOURCE_EXPECTED_DB_NAME: database,
      SECURE_GUARD_SOURCE_DB_USER: readerRole,
      SECURE_GUARD_SOURCE_DB_PASSWORD: fixturePassword,
    }));
    await reader.connect();
    try {
      const result = await collectInventory(reader, database);
      assert.equal(result.readOnly, true);
      assert.equal(result.principal, readerRole);
      assert.deepEqual(result.migrations.map((r) => r.filename), [
        '011_secure_guard_identity_scope.sql', '012_secure_guard_organization_independence.sql',
      ]);
      assert.equal(result.relations.length, 2);
      assert.ok(result.missingRelations.includes('portal_users'));
      assert.equal(result.foreignKeys.length, 1);
      assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_CUSTOMER|fixturePassword/);
      await assert.rejects(collectInventory(reader, 'different_database'), /identity/);
      await assert.rejects(reader.query("INSERT INTO customer_organizations VALUES (2, 'should-fail')"),
        (error) => error.code === '42501');
    } finally { await reader.end(); }
  });
