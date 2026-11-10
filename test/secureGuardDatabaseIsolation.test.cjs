const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readSecureGuardDatabaseSettings, createSecureGuardDatabasePool } = require('../dist/db/secureGuardDatabase');

function env(extra = {}) {
  return {
    DB_NAME: 'legacy_portal',
    SECURE_GUARD_DB_MODE: 'dedicated',
    SECURE_GUARD_DB_HOST: '127.0.0.1',
    SECURE_GUARD_DB_NAME: 'secure_guard',
    SECURE_GUARD_DB_USER: 'secure_guard_runtime',
    SECURE_GUARD_DB_PASSWORD: 'dummy-for-test',
    ...extra,
  };
}

test('legacy compatibility is explicit and the cutover guard prevents silent fallback', () => {
  assert.equal(readSecureGuardDatabaseSettings({ DB_NAME: 'legacy_portal' }), null);
  assert.throws(() => readSecureGuardDatabaseSettings({
    SECURE_GUARD_DB_REQUIRE_DEDICATED: 'true',
  }), /dedicated database required/);
  assert.throws(() => readSecureGuardDatabaseSettings({ SECURE_GUARD_DB_MODE: 'unknown' }), /Invalid/);
});

test('dedicated SG credentials never fall back to legacy Portal user/password or database', () => {
  assert.throws(() => readSecureGuardDatabaseSettings(env({ SECURE_GUARD_DB_PASSWORD: undefined,
    DB_PASSWORD: 'legacy-secret' })), /SECURE_GUARD_DB_PASSWORD/);
  assert.throws(() => readSecureGuardDatabaseSettings(env({ SECURE_GUARD_DB_NAME: 'legacy_portal' })), /must differ/);
  assert.throws(() => readSecureGuardDatabaseSettings(env({ SECURE_GUARD_DB_SOCKET_PATH: '/cloudsql/sg' })), /either SG socket/);
  assert.throws(() => readSecureGuardDatabaseSettings(env({ SECURE_GUARD_DB_PORT: 'nope' })), /Invalid/);
});

test('SG runtime and migration principals are distinct and have bounded pools', async () => {
  const runtime = readSecureGuardDatabaseSettings(env());
  assert.ok(runtime);
  assert.equal(runtime.maxConnections, 2);
  const pool = createSecureGuardDatabasePool(runtime);
  assert.equal(pool.options.max, 2);
  assert.equal(pool.options.database, 'secure_guard');
  await pool.end();

  const migration = readSecureGuardDatabaseSettings(env({
    SECURE_GUARD_MIGRATION_DB_USER: 'secure_guard_ddl',
    SECURE_GUARD_MIGRATION_DB_PASSWORD: 'migration-secret-test',
  }), 'migration');
  assert.equal(migration.user, 'secure_guard_ddl');
  assert.equal(migration.maxConnections, 1);
  assert.throws(() => readSecureGuardDatabaseSettings(env(), 'migration'), /MIGRATION_DB_USER/);

  const overage = readSecureGuardDatabaseSettings(env({
    SECURE_GUARD_OVERAGE_DB_USER: 'secure_guard_overage',
    SECURE_GUARD_OVERAGE_DB_PASSWORD: 'overage-secret-test',
    SECURE_GUARD_DB_NAME: 'secure_guard_staging',
  }), 'overage');
  assert.equal(overage.user, 'secure_guard_overage');
  assert.equal(overage.name, 'secure_guard_staging');
  assert.equal(overage.maxConnections, 2);
  const overagePool = createSecureGuardDatabasePool(overage);
  assert.equal(overagePool.options.max, 2);
  await overagePool.end();
  assert.throws(() => readSecureGuardDatabaseSettings(env(), 'overage'), /OVERAGE_DB_USER/);
  assert.throws(() => readSecureGuardDatabaseSettings(env({
    SECURE_GUARD_OVERAGE_DB_USER: 'secure_guard_overage',
  }), 'overage'), /OVERAGE_DB_PASSWORD/);
  assert.throws(() => readSecureGuardDatabaseSettings({ DB_NAME: 'legacy_portal' }, 'overage'),
    /dedicated database required/);
});

test('SG-only baseline has all domain tables but no legacy customer FK or global schema mutations', () => {
  const root = path.join(__dirname, '..');
  const dir = path.join(root, 'migrations', 'secure_guard');
  const filenames = fs.readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
  assert.deepEqual(filenames, ['001_identity_scope_baseline.sql', '002_overage_alerts.sql']);
  const sql = filenames.map((name) => fs.readFileSync(path.join(dir, name), 'utf8')).join('\n');
  const tables = [
    'portal_users', 'customer_organizations', 'customer_memberships', 'msp_role_grants',
    'dnsfilter_organization_mappings', 'secure_guard_receipts',
    'secure_guard_audit_events', 'secure_guard_overage_alerts',
  ];
  tables.forEach((name) => assert.match(sql, new RegExp(`CREATE TABLE ${name} \\(`)));
  assert.doesNotMatch(sql, /REFERENCES\s+customers\s*\(/i);
  assert.doesNotMatch(sql, /UPDATE\s+customers\b/i);
  assert.match(sql, /organization_name VARCHAR\(255\) NOT NULL/);
  assert.match(sql, /idx_customer_memberships_pending_initial_admin/);
  assert.match(sql, /secure_guard_overage_one_open_per_organization/);
  const normalizeSql = (value) => value.replace(/^--.*$/gm, '').replace(/\s+/g, ' ').trim();
  const legacyOverage = fs.readFileSync(path.join(root, 'migrations', '015_secure_guard_overage_alerts.sql'), 'utf8');
  const dedicatedOverage = fs.readFileSync(path.join(dir, '002_overage_alerts.sql'), 'utf8');
  assert.equal(normalizeSql(dedicatedOverage), normalizeSql(legacyOverage));
  const runner = fs.readFileSync(path.join(root, 'migrations', 'secure_guard_runner.ts'), 'utf8');
  assert.match(runner, /secure_guard_schema_migrations/);
  assert.match(runner, /SECURE_GUARD_MIGRATION_APPROVED/);
  assert.match(runner, /'migration'/);
  assert.doesNotMatch(runner, /migrations\/runner/);
});

test('overage Job uses its least-privilege identity without loading Portal business secrets', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'jobs', 'secureGuardOverageOnce.ts'), 'utf8');
  assert.match(source, /readSecureGuardDatabaseSettings\(process\.env, 'overage'\)/);
  assert.doesNotMatch(source, /loadConfig|DB_PASSWORD|ZABBIX_API_|SMTP_PASSWORD|STAFF_JWT_SECRET/);
  assert.match(source, /SECURE_GUARD_LICENSE_ALERT_SLACK_WEBHOOK/);
  assert.match(source, /SECURE_GUARD_MANAGEMENT_URL/);
});
