const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '../src/db/secureGuardStagingBootstrap.ts'),
  'utf8',
);
const secretScript = fs.readFileSync(
  path.join(__dirname, '../scripts/secure-guard-staging-secret-versions.ps1'),
  'utf8',
);
const iamScript = fs.readFileSync(
  path.join(__dirname, '../scripts/secure-guard-staging-secret-iam.ps1'),
  'utf8',
);
const cloudBuild = fs.readFileSync(
  path.join(__dirname, '../cloudbuild.secure-guard-bootstrap.yaml'),
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

test('PowerShell 5.1 secret initialization uses disposable RNG and stdin only', () => {
  assert.match(secretScript, /RandomNumberGenerator\]::Create\(\)/);
  assert.match(secretScript, /\.GetBytes\(\$bytes\)/);
  assert.match(secretScript, /\$rng\.Dispose\(\)/);
  assert.match(secretScript, /--data-file=-/);
  assert.match(secretScript, /SECRET_NOT_EMPTY_STOP/);
  assert.doesNotMatch(secretScript, /RandomNumberGenerator\]::Fill/);
  assert.doesNotMatch(secretScript, /Write-(?:Output|Host).*\$password|Set-Content.*\$password/);
});

test('PowerShell 5.1 IAM setup passes explicit validated string values', () => {
  assert.match(iamScript, /\$secret = \[string\]\$item\['Secret'\]/);
  assert.match(iamScript, /\$member = \[string\]\$item\['Member'\]/);
  assert.match(iamScript, /SECRET_TARGET_MISMATCH/);
  assert.match(iamScript, /IAM_MEMBER_MISMATCH/);
  assert.match(iamScript, /ValidateSet\('Grant', 'RemoveBootstrap'\)/);
  assert.doesNotMatch(iamScript, /--member=\$item\.Member/);
});

test('bootstrap Cloud Build uses only Cloud Logging with an explicit image', () => {
  assert.match(cloudBuild, /logging: CLOUD_LOGGING_ONLY/);
  assert.match(cloudBuild, /docker[\s\S]*build[\s\S]*docker[\s\S]*push/);
  assert.match(cloudBuild, /\$\{_IMAGE\}/);
  assert.doesNotMatch(cloudBuild, /gcloud\s+run|jobs\s+execute|args:\s*\[[^\]]*['"]deploy['"]/);
});
