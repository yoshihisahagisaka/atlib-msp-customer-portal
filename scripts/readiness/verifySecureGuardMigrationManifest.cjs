'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const expectedNames = [
  '001_identity_scope_baseline.sql',
  '002_overage_alerts.sql',
  '003_license_alert_snapshot.sql',
  '004_agent_uninstall_claims.sql',
];

function fail(message) {
  throw new Error(`SECURE_GUARD_MIGRATION_MANIFEST_INVALID: ${message}`);
}

function verify(manifestPath, migrationsDirectory, strict = true) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1
    || manifest.database !== 'secure_guard_staging'
    || manifest.role !== 'secure_guard_migration_staging') {
    fail('unexpected database or role target');
  }
  if (!Array.isArray(manifest.migrations) || manifest.migrations.length !== 4) {
    fail('exactly four migrations are required');
  }
  const names = manifest.migrations.map((entry) => entry.filename);
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    fail('migration order or filename differs from 001-004 allowlist');
  }
  for (const entry of manifest.migrations) {
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) fail(`invalid SHA-256 for ${entry.filename}`);
    const content = fs.readFileSync(path.join(migrationsDirectory, entry.filename));
    const actual = crypto.createHash('sha256').update(content).digest('hex');
    if (actual !== entry.sha256) fail(`SHA-256 mismatch for ${entry.filename}`);
  }
  if (strict) {
    const actualNames = fs.readdirSync(migrationsDirectory)
      .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
      .sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
      fail('artifact contains missing or additional migrations');
    }
  }
  return {
    database: manifest.database,
    role: manifest.role,
    count: names.length,
    filenames: names,
  };
}

if (require.main === module) {
  const [manifestPath, migrationsDirectory, strictValue = 'true'] = process.argv.slice(2);
  if (!manifestPath || !migrationsDirectory) {
    fail('usage: verifySecureGuardMigrationManifest.cjs <manifest> <directory> [strict]');
  }
  const result = verify(
    path.resolve(manifestPath),
    path.resolve(migrationsDirectory),
    strictValue !== 'false',
  );
  process.stdout.write(`${JSON.stringify({
    event: 'secure_guard_migration_manifest_verified',
    ...result,
  })}\n`);
}

module.exports = { expectedNames, verify };
