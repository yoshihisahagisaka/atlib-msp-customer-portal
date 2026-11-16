const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const verifier = require('../scripts/readiness/verifySecureGuardMigrationManifest.cjs');
const manifestPath = path.join(root, 'migration-manifests/secure-guard-staging-001-004.json');
const migrationsDirectory = path.join(root, 'migrations/secure_guard');

test('SG migration manifest fixes exactly 001-004 and their approved SHA-256 values', () => {
  const result = verifier.verify(manifestPath, migrationsDirectory, true);
  assert.equal(result.database, 'secure_guard_staging');
  assert.equal(result.role, 'secure_guard_migration_staging');
  assert.equal(result.count, 4);
  assert.deepEqual(result.filenames, verifier.expectedNames);
});

test('approved migration hashes are stable across Windows and Linux checkout line endings', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-migration-lf-'));
  try {
    for (const name of verifier.expectedNames) {
      const content = fs.readFileSync(path.join(migrationsDirectory, name), 'utf8');
      fs.writeFileSync(path.join(temporary, name), content.replace(/\r\n/g, '\n'));
    }
    assert.equal(verifier.verify(manifestPath, temporary, true).count, 4);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('manifest verifier stops on missing, extra, reordered or changed SQL before execution', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-migration-manifest-'));
  try {
    for (const name of verifier.expectedNames) {
      fs.copyFileSync(path.join(migrationsDirectory, name), path.join(temporary, name));
    }
    fs.appendFileSync(path.join(temporary, verifier.expectedNames[0]), '\n-- deliberate fixture drift\n');
    assert.throws(() => verifier.verify(manifestPath, temporary, true), /SHA-256 mismatch/);
    fs.copyFileSync(
      path.join(migrationsDirectory, verifier.expectedNames[0]),
      path.join(temporary, verifier.expectedNames[0]),
    );
    fs.writeFileSync(path.join(temporary, '005_unapproved.sql'), 'SELECT 1;\n');
    assert.throws(() => verifier.verify(manifestPath, temporary, true), /missing or additional/);
    fs.rmSync(path.join(temporary, '005_unapproved.sql'));
    fs.rmSync(path.join(temporary, verifier.expectedNames[3]));
    assert.throws(() => verifier.verify(manifestPath, temporary, true), /ENOENT/);

    const reordered = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    [reordered.migrations[0], reordered.migrations[1]] =
      [reordered.migrations[1], reordered.migrations[0]];
    const reorderedPath = path.join(temporary, 'manifest.json');
    fs.writeFileSync(reorderedPath, JSON.stringify(reordered));
    assert.throws(() => verifier.verify(reorderedPath, migrationsDirectory, true), /order or filename/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('dedicated migration artifact has no web startup and validates its manifest while building', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile.secure-guard-migration'), 'utf8');
  assert.match(dockerfile, /npm run build:secure-guard-migration/);
  assert.match(dockerfile, /verifySecureGuardMigrationManifest\.cjs/);
  assert.match(dockerfile, /COPY migrations\/secure_guard \.\/migrations\/secure_guard/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /secure_guard_runner\.js/);
  assert.doesNotMatch(dockerfile, /EXPOSE|dist\/server\.js|ts-node/);

  const cloudbuild = fs.readFileSync(path.join(root, 'cloudbuild.secure-guard-migration.yaml'), 'utf8');
  assert.match(cloudbuild, /Dockerfile\.secure-guard-migration/);
  assert.match(cloudbuild, /logging: CLOUD_LOGGING_ONLY/);
});

test('runner verifies manifest, configured identity and server identity before ledger DDL', () => {
  const source = fs.readFileSync(path.join(root, 'migrations/secure_guard_runner.ts'), 'utf8');
  const manifest = source.indexOf('execFileSync(process.execPath');
  const pool = source.indexOf('createSecureGuardDatabasePool(settings)');
  const identity = source.indexOf("SELECT current_database() AS database");
  const ledger = source.indexOf('CREATE TABLE IF NOT EXISTS secure_guard_schema_migrations');
  assert.ok(manifest >= 0 && manifest < pool);
  assert.ok(identity > pool && identity < ledger);
  assert.match(source, /settings\.name !== 'secure_guard_staging'/);
  assert.match(source, /settings\.user !== 'secure_guard_migration_staging'/);
  assert.match(source, /SECURE_GUARD_MIGRATION_TARGET_CONFIRMATION/);
});

test('migration Job template is one-shot, migration-only and uses only its Secret', () => {
  const job = fs.readFileSync(
    path.join(root, 'deploy/secure-guard-db-migrate-staging-once.yaml.template'), 'utf8',
  );
  assert.match(job, /name: secure-guard-db-migrate-staging-once/);
  assert.match(job, /serviceAccountName: secure-guard-db-migration-stg@/);
  assert.match(job, /taskCount: 1/);
  assert.match(job, /parallelism: 1/);
  assert.match(job, /maxRetries: 0/);
  assert.match(job, /secure-guard-stg-db-migration-password/);
  assert.doesNotMatch(job, /runtime-password|overage-password|bootstrap-password/);
  assert.match(job, /SECURE_GUARD_MIGRATION_APPROVED, value: 'true'/);
  assert.match(job, /__MIGRATION_IMAGE_DIGEST__/);
});
