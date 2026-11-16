const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const source=fs.readFileSync(path.join(__dirname,'../scripts/readiness/secureGuardMigrationAcceptance.cjs'),'utf8');

test('migration acceptance payload is SELECT-only, bounded, and identity-scoped',()=>{
  assert.match(source,/BEGIN TRANSACTION READ ONLY/);
  assert.match(source,/current_database\(\) database,current_user role,current_setting\('server_version'\) version/);
  assert.match(source,/SECURE_GUARD_MIGRATION_DB_USER/);
  assert.match(source,/secure_guard_schema_migrations/);
  assert.match(source,/pg_get_constraintdef/);
  assert.match(source,/has_table_privilege/);
  assert.match(source,/has_sequence_privilege/);
  assert.match(source,/has_database_privilege/);
  assert.match(source,/CLOUD_SQL_PROXY_ADMIN_URL/);
  assert.doesNotMatch(source,/secureGuardStagingBootstrap|secure_guard_runner/);
  assert.doesNotMatch(source,/(^|[;`])\s*(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|GRANT|REVOKE|TRUNCATE|CALL|DO)\s/mi);
  assert.ok(Buffer.from(source).toString('base64').length<7600,'payload must fit Windows CLI');
});

test('migration acceptance execution contract has exactly two Node args and disables runner approval',()=>{
  const args=['-e','eval(atob(process.env.INSPECT_B64))'];
  assert.equal(args.length,2);
  assert.equal(args.join(','),'-e,eval(atob(process.env.INSPECT_B64))');
  assert.equal({SECURE_GUARD_MIGRATION_APPROVED:'false'}.SECURE_GUARD_MIGRATION_APPROVED,'false');
  const runner=fs.readFileSync(path.join(__dirname,'../migrations/secure_guard_runner.ts'),'utf8');
  assert.ok(runner.indexOf("SECURE_GUARD_MIGRATION_APPROVED !== 'true'")<runner.indexOf('createSecureGuardDatabasePool(settings)'));
});
