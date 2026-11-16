const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');

const host = '127.0.0.1';
const port = 55432;
const database = 'secure_guard_staging';
const role = 'secure_guard_migration_staging';
const runtimeRole = 'secure_guard_runtime_staging';
const overageRole = 'secure_guard_overage_staging';
const password = 'local_ci_fixture_password_not_a_secret';
const image = 'secure-guard-migration-ci:current';
const approvedManifest = require('../../migration-manifests/secure-guard-staging-001-005.json');

function client(databaseName = 'postgres') {
  return new Client({ host, port, database: databaseName, user: 'postgres', password });
}

function runImage(overrides = {}) {
  const environment = {
    SECURE_GUARD_DB_MODE: 'dedicated',
    SECURE_GUARD_DB_HOST: host,
    SECURE_GUARD_DB_PORT: String(port),
    SECURE_GUARD_DB_NAME: database,
    SECURE_GUARD_MIGRATION_DB_USER: role,
    SECURE_GUARD_MIGRATION_DB_PASSWORD: password,
    SECURE_GUARD_MIGRATION_APPROVED: 'true',
    SECURE_GUARD_MIGRATION_TARGET_CONFIRMATION:
      'msp-zabbix:asia-northeast1:secumie-sg-shared-staging-db/secure_guard_staging',
    ...overrides,
  };
  const args = ['run', '--rm', '--network', 'host'];
  for (const [key, value] of Object.entries(environment)) args.push('-e', `${key}=${value}`);
  args.push(image);
  return spawnSync('docker', args, { encoding: 'utf8', timeout: 30000 });
}

test('dedicated migration image applies and safely replays exact 001-005', { timeout: 90000 }, async () => {
  assert.equal(process.platform, 'linux');
  assert.equal(process.env.CI, 'true');
  assert.equal(process.env.SECURE_GUARD_MIGRATION_IMAGE_E2E_ENABLED, 'true');
  const admin = client();
  await admin.connect();
  try {
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [database]);
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.query(`DROP ROLE IF EXISTS ${runtimeRole}`);
    await admin.query(`DROP ROLE IF EXISTS ${overageRole}`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.query(`CREATE ROLE ${role} LOGIN NOINHERIT PASSWORD '${password}'`);
    await admin.query(`CREATE ROLE ${runtimeRole} LOGIN NOINHERIT PASSWORD '${password}'`);
    await admin.query(`CREATE ROLE ${overageRole} LOGIN NOINHERIT PASSWORD '${password}'`);
    await admin.query(`CREATE DATABASE ${database} OWNER ${role}`);

    const wrongTarget = runImage({ SECURE_GUARD_DB_NAME: 'postgres' });
    assert.notEqual(wrongTarget.status, 0, 'wrong target must stop before database access');
    const noLedgerInPostgres = await admin.query(
      "SELECT to_regclass('public.secure_guard_schema_migrations')::text AS ledger",
    );
    assert.equal(noLedgerInPostgres.rows[0].ledger, null);

    const first = runImage();
    assert.equal(first.status, 0, `container migration must pass: ${first.stderr}`);
    assert.match(first.stdout, /secure_guard_migration_manifest_verified/);
    assert.match(first.stdout, /applied: 005_runtime_overage_privileges\.sql/);

    const replay = runImage();
    assert.equal(replay.status, 0, `container replay must pass: ${replay.stderr}`);
    assert.match(replay.stdout, /skip verified: 001_identity_scope_baseline\.sql/);

    const migrated = client(database);
    await migrated.connect();
    try {
      const ledger = await migrated.query(
        'SELECT filename, sha256 FROM secure_guard_schema_migrations ORDER BY filename',
      );
      assert.equal(ledger.rowCount, 5);
      assert.deepEqual(ledger.rows.map((row) => row.filename), [
        '001_identity_scope_baseline.sql',
        '002_overage_alerts.sql',
        '003_license_alert_snapshot.sql',
        '004_agent_uninstall_claims.sql',
        '005_runtime_overage_privileges.sql',
      ]);
      assert.deepEqual(
        ledger.rows.map((row) => row.sha256),
        approvedManifest.migrations.map((entry) => entry.sha256),
      );
      const privilegeContract = await migrated.query(`SELECT
        has_schema_privilege($1, 'public', 'USAGE') AS runtime_usage,
        has_table_privilege($1, 'public.portal_users', 'SELECT') AS runtime_users_select,
        has_table_privilege($1, 'public.secure_guard_schema_migrations', 'SELECT') AS runtime_ledger_select,
        has_schema_privilege($2, 'public', 'USAGE') AS overage_usage,
        has_table_privilege($2, 'public.customer_organizations', 'SELECT') AS overage_org_select,
        has_table_privilege($2, 'public.portal_users', 'SELECT') AS overage_users_select,
        has_table_privilege($2, 'public.secure_guard_overage_alerts', 'DELETE') AS overage_alert_delete
      `, [runtimeRole, overageRole]);
      assert.deepEqual(privilegeContract.rows[0], {
        runtime_usage: true,
        runtime_users_select: true,
        runtime_ledger_select: false,
        overage_usage: true,
        overage_org_select: true,
        overage_users_select: false,
        overage_alert_delete: false,
      });
    } finally {
      await migrated.end();
    }
  } finally {
    await admin.end();
  }
});
