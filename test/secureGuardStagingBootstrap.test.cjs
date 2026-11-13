const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '../src/db/secureGuardStagingBootstrap.ts'),
  'utf8',
);

test('staging bootstrap is fixed to the approved empty database and three principals', () => {
  assert.match(source, /secure_guard_staging/);
  assert.match(source, /secure_guard_runtime_staging/);
  assert.match(source, /secure_guard_overage_staging/);
  assert.match(source, /secure_guard_migration_staging/);
  assert.match(source, /CONNECTION LIMIT %s/);
  assert.match(source, /migrationsApplied: 0/);
});

test('staging bootstrap fails closed and verifies cross-database isolation', () => {
  assert.match(source, /TARGET_CONFIRMATION_MISMATCH/);
  assert.match(source, /DATABASE_EXISTENCE_STOP/);
  assert.match(source, /ROLE_EXISTENCE_STOP/);
  assert.match(source, /CROSS_DATABASE_CONNECT_UNEXPECTEDLY_ALLOWED/);
  assert.match(source, /SECU_CROSS_DATABASE_ACCESS_FAILED/);
  assert.doesNotMatch(source, /DROP DATABASE|DROP ROLE|ALTER ROLE/);
});

test('staging bootstrap never emits passwords or dynamic exception details', () => {
  assert.match(source, /secure_guard_staging_bootstrap_failed', stage/);
  assert.doesNotMatch(source, /console\.error\(error|stderr\.write\([^\n]*error/);
  assert.doesNotMatch(source, /DB_BOOTSTRAP_PASSWORD.*process\.stdout|SG_RUNTIME_DB_PASSWORD.*process\.stdout/);
});
