import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { loadConfig } from '../src/config';
import { createPool } from '../src/db/pool';

/**
 * 軽量マイグレーションランナー。migrations/*.sql をファイル名昇順で適用し、
 * schema_migrations テーブルに適用済みファイル名を記録する。
 * フレームワーク導入は3テーブル程度の規模には過剰と判断し、自前の最小実装とした。
 */
async function run(): Promise<void> {
  const config = await loadConfig();
  const pool: Pool = createPool(config);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const dir = __dirname;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const { rows } = await pool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
    if (rows.length > 0) {
      console.log(`skip (already applied): ${file}`);
      continue;
    }

    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    console.log(`applying: ${file}`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`  done`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
