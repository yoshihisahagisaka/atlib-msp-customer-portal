const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');

// The test may only operate on the disposable local PostgreSQL 16 service in CI.
// It cannot target GCP, a Cloud SQL proxy, a production database, or a remote address.
const safeTestHost = '127.0.0.1';
const safeTestPort = 55432;
const targetDatabase = 'secure_guard_ci';
const migrationUser = 'secure_guard_ci_ddl';
const runtimeUser = 'secure_guard_ci_runtime';
const fixturePassword = 'local_ci_fixture_password_not_a_secret';

function client(database, user, password) {
  return new Client({
    host: safeTestHost, port: safeTestPort, database, user, password,
    connectionTimeoutMillis: 3000,
  });
}

function runMigration() {
  return spawnSync(process.execPath, ['-r', 'ts-node/register', 'migrations/secure_guard_runner.ts'], {
    cwd: path.join(__dirname, '../..'),
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      SECURE_GUARD_DB_MODE: 'dedicated',
      SECURE_GUARD_DB_HOST: safeTestHost,
      SECURE_GUARD_DB_PORT: String(safeTestPort),
      SECURE_GUARD_DB_NAME: targetDatabase,
      SECURE_GUARD_MIGRATION_DB_USER: migrationUser,
      SECURE_GUARD_MIGRATION_DB_PASSWORD: fixturePassword,
      SECURE_GUARD_MIGRATION_APPROVED: 'true',
      // Never use the legacy DB principal, socket or endpoint.
      SECURE_GUARD_DB_SOCKET_PATH: '',
      DB_NAME: 'legacy_portal_ci',
    },
  });
}

test('PostgreSQL 16: SG baseline, idempotent runner and role/database isolation', { timeout: 90000 }, async () => {
  assert.equal(process.env.CI, 'true', 'CI-only integration test');
  assert.equal(process.env.SECURE_GUARD_DB_E2E_ENABLED, 'true', 'Explicit opt-in required');
  assert.equal(process.env.NODE_ENV, 'test', 'Test environment required');
  assert.equal(process.env.SECURE_GUARD_DB_E2E_HOST, safeTestHost);
  assert.equal(process.env.SECURE_GUARD_DB_E2E_PORT, String(safeTestPort));

  const admin = client('postgres', 'postgres', fixturePassword);
  await admin.connect();
  try {
    await admin.query(`CREATE ROLE ${migrationUser} LOGIN PASSWORD '${fixturePassword}'`);
    await admin.query(`CREATE ROLE ${runtimeUser} LOGIN PASSWORD '${fixturePassword}'`);
    await admin.query(`CREATE DATABASE ${targetDatabase} OWNER ${migrationUser}`);
    await admin.query('CREATE DATABASE secumie_insight_ci');
    await admin.query('REVOKE CONNECT ON DATABASE secumie_insight_ci FROM PUBLIC');
    await admin.query(`GRANT CONNECT ON DATABASE ${targetDatabase} TO ${runtimeUser}`);

    const first = runMigration();
    assert.equal(first.status, 0, `First SG-only migration must pass: ${first.stderr}`);
    assert.match(first.stdout, /applied: 001_identity_scope_baseline\.sql/);
    assert.match(first.stdout, /applied: 002_overage_alerts\.sql/);

    const replay = runMigration();
    assert.equal(replay.status, 0, `Migration replay must be safe: ${replay.stderr}`);
    assert.match(replay.stdout, /skip verified: 001_identity_scope_baseline\.sql/);
    assert.match(replay.stdout, /skip verified: 002_overage_alerts\.sql/);

    const ddl = client(targetDatabase, migrationUser, fixturePassword);
    await ddl.connect();
    try {
      const ledger = await ddl.query('SELECT filename FROM secure_guard_schema_migrations ORDER BY filename');
      assert.deepEqual(ledger.rows.map((row) => row.filename), [
        '001_identity_scope_baseline.sql', '002_overage_alerts.sql',
      ]);
      const tables = await ddl.query(`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
      `);
      assert.deepEqual(tables.rows.map((row) => row.tablename), [
        'customer_memberships', 'customer_organizations', 'dnsfilter_organization_mappings',
        'msp_role_grants', 'portal_users', 'secure_guard_audit_events',
        'secure_guard_overage_alerts', 'secure_guard_receipts', 'secure_guard_schema_migrations',
      ]);
      const crossFk = await ddl.query(`
        SELECT count(*)::integer AS count FROM pg_constraint
        WHERE contype = 'f' AND confrelid = to_regclass('public.customers')
      `);
      assert.equal(crossFk.rows[0].count, 0);
      await ddl.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await ddl.query(`GRANT USAGE ON SCHEMA public TO ${runtimeUser}`);
      await ddl.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${runtimeUser}`);
      await ddl.query(`REVOKE ALL PRIVILEGES ON secure_guard_schema_migrations FROM ${runtimeUser}`);
      await ddl.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${runtimeUser}`);
    } finally {
      await ddl.end();
    }

    const runtime = client(targetDatabase, runtimeUser, fixturePassword);
    await runtime.connect();
    try {
      const createdUser = await runtime.query(
        `INSERT INTO portal_users(email) VALUES('ci@example.invalid') RETURNING id`,
      );
      const createdOrg = await runtime.query(
        `INSERT INTO customer_organizations(organization_name) VALUES('CI Fixture Organization') RETURNING id`,
      );
      const membership = [createdUser.rows[0].id, createdOrg.rows[0].id];
      await runtime.query(`
        INSERT INTO customer_memberships
          (user_id, customer_organization_id, role, is_initial_admin, status, invite_token_hash, invite_expires_at)
        VALUES ($1, $2, 'org_admin', true, 'pending', 'test-only-hash', now() + interval '1 day')
      `, membership);
      await assert.rejects(runtime.query(`
        INSERT INTO customer_memberships
          (user_id, customer_organization_id, role, is_initial_admin, status, invite_token_hash, invite_expires_at)
        VALUES ($1, $2, 'org_admin', true, 'pending', 'test-only-hash2', now() + interval '1 day')
      `, membership), (error) => error.code === '23505');
      await runtime.query(`
        INSERT INTO secure_guard_overage_alerts
          (customer_organization_id, last_observed_at, allocated_rc_licenses, roaming_clients_in_use, over_by)
        VALUES ($1, now(), 1, 2, 1)
      `, [createdOrg.rows[0].id]);
      await assert.rejects(runtime.query('CREATE TABLE cross_role_write_denied (id integer)'),
        (error) => error.code === '42501');
      await assert.rejects(runtime.query('SELECT * FROM secure_guard_schema_migrations'),
        (error) => error.code === '42501');
    } finally {
      await runtime.end();
    }

    const otherDb = client('secumie_insight_ci', runtimeUser, fixturePassword);
    await assert.rejects(otherDb.connect(), (error) => error.code === '42501');
    await otherDb.end().catch(() => undefined);

    const driftDdl = client(targetDatabase, migrationUser, fixturePassword);
    await driftDdl.connect();
    try {
      await driftDdl.query(`UPDATE secure_guard_schema_migrations SET sha256 = 'deliberate-ci-drift'
        WHERE filename = '001_identity_scope_baseline.sql'`);
    } finally {
      await driftDdl.end();
    }
    const drift = runMigration();
    assert.notEqual(drift.status, 0, 'Modified checksum must block runner');
  } finally {
    await admin.end();
  }
});
