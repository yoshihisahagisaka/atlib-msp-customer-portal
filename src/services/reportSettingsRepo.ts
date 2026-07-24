import type { Pool } from 'pg';

export interface ReportSettings {
  customerCode: string;
  wanIfIn: string | null;
  wanIfOut: string | null;
  updatedAt: string;
}

interface Row {
  customer_code: string;
  wan_if_in: string | null;
  wan_if_out: string | null;
  updated_at: string;
}

/**
 * customer_report_settings への問い合わせを一手に引き受けるリポジトリ。
 * atlib_monthly_report.htmlの手動選択・localStorage保存とは独立した経路で、
 * 将来のバッチ生成(Puppeteer)がcustomer_codeから直接参照する用途。
 */
export class ReportSettingsRepo {
  constructor(private readonly pool: Pool) {}

  async findByCustomerCode(customerCode: string): Promise<ReportSettings | null> {
    const { rows } = await this.pool.query<Row>(
      'SELECT customer_code, wan_if_in, wan_if_out, updated_at FROM customer_report_settings WHERE customer_code = $1',
      [customerCode],
    );
    const row = rows[0];
    return row ? mapRow(row) : null;
  }

  async upsert(
    customerCode: string,
    input: { wanIfIn: string | null; wanIfOut: string | null },
  ): Promise<ReportSettings> {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO customer_report_settings (customer_code, wan_if_in, wan_if_out)
       VALUES ($1, $2, $3)
       ON CONFLICT (customer_code) DO UPDATE
         SET wan_if_in = EXCLUDED.wan_if_in, wan_if_out = EXCLUDED.wan_if_out, updated_at = now()
       RETURNING customer_code, wan_if_in, wan_if_out, updated_at`,
      [customerCode, input.wanIfIn, input.wanIfOut],
    );
    const row = rows[0];
    if (!row) throw new Error('ReportSettingsRepo.upsert: insert returned no row');
    return mapRow(row);
  }
}

function mapRow(row: Row): ReportSettings {
  return {
    customerCode: row.customer_code,
    wanIfIn: row.wan_if_in,
    wanIfOut: row.wan_if_out,
    updatedAt: row.updated_at,
  };
}
