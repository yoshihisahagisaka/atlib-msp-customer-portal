import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { createSecureGuardDatabasePool, readSecureGuardDatabaseSettings } from '../src/db/secureGuardDatabase';

/**
 * Explicitly approved, empty-database SG-only migrations. Never call the Portal migration runner
 * with a Secure Guard connection: it applies all legacy 001+ scripts to the selected database.
 */
async function main(): Promise<void> {
  if (process.env.SECURE_GUARD_MIGRATION_APPROVED !== 'true') {
    throw new Error('Secure Guard migration needs explicit staging/production approval');
  }
  const settings = readSecureGuardDatabaseSettings(process.env, 'migration');
  if (!settings) throw new Error('Secure Guard migration requires a dedicated database');
  const pool = createSecureGuardDatabasePool(settings);
  let client: PoolClient | undefined;
  let locked = false;
  try {
    client = await pool.connect();
    await client.query('SELECT pg_advisory_lock($1::bigint)', ['6004588700000105']);
    locked = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS secure_guard_schema_migrations (
        filename TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const migrationDir = path.join(__dirname, 'secure_guard');
    const names = fs.readdirSync(migrationDir).filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
    if (names.length === 0) throw new Error('No Secure Guard migrations found');
    const applied = await client.query<{ filename: string }>(
      'SELECT filename FROM secure_guard_schema_migrations',
    );
    for (const row of applied.rows) {
      if (!names.includes(row.filename)) throw new Error('Unknown Secure Guard migration in ledger');
    }

    for (const filename of names) {
      const sql = fs.readFileSync(path.join(migrationDir, filename), 'utf8');
      const sha256 = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query<{ sha256: string }>(
        'SELECT sha256 FROM secure_guard_schema_migrations WHERE filename = $1', [filename],
      );
      if (existing.rows.length > 0) {
        if (existing.rows[0]?.sha256 !== sha256) {
          throw new Error(`Secure Guard migration drift: ${filename}`);
        }
        console.log(`skip verified: ${filename}`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO secure_guard_schema_migrations (filename, sha256) VALUES ($1, $2)', [filename, sha256]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      console.log(`applied: ${filename}`);
    }
  } finally {
    if (client) {
      if (locked) {
        try { await client.query('SELECT pg_advisory_unlock($1::bigint)', ['6004588700000105']); }
        catch { process.exitCode = 1; }
      }
      client.release();
    }
    await pool.end();
  }
}

main().catch(() => {
  // Do not log SQL, secret values, customer identities, or driver connection details.
  console.error('Secure Guard migration stopped; inspect restricted diagnostics.');
  process.exitCode = 1;
});
