import type { Pool } from 'pg';

/** portal_settings への問い合わせを一手に引き受けるリポジトリ。キーのホワイトリストはdomain/portalSettings.ts側の責務。 */
export class SettingsRepo {
  constructor(private readonly pool: Pool) {}

  /** 行が存在しない場合はnull（呼び出し側でenvデフォルトにフォールバックする）。 */
  async get(key: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ value: string }>(
      'SELECT value FROM portal_settings WHERE key = $1',
      [key],
    );
    return rows[0]?.value ?? null;
  }

  async getMany(keys: string[]): Promise<Record<string, string>> {
    if (keys.length === 0) return {};
    const { rows } = await this.pool.query<{ key: string; value: string }>(
      'SELECT key, value FROM portal_settings WHERE key = ANY($1)',
      [keys],
    );
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async set(key: string, value: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO portal_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, value],
    );
  }
}
