import type { Pool } from 'pg';

export type MonthlyReportStatus = 'draft' | 'approved' | 'sent' | 'failed';

export interface MonthlyReport {
  id: string;
  customerCode: string;
  reportPeriod: string;
  status: MonthlyReportStatus;
  filePath: string | null;
  errorMessage: string | null;
  generatedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  createdAt: string;
}

interface Row {
  id: string;
  customer_code: string;
  report_period: string;
  status: MonthlyReportStatus;
  file_path: string | null;
  error_message: string | null;
  generated_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  sent_at: string | null;
  created_at: string;
}

const SELECT_COLUMNS = `id, customer_code, report_period, status, file_path, error_message,
       generated_at, approved_by, approved_at, sent_at, created_at`;

/**
 * monthly_reports への問い合わせを一手に引き受けるリポジトリ。
 * 1顧客×1ヶ月で1レコード(customer_code, report_periodのUNIQUE制約)。再生成時は上書き。
 */
export class MonthlyReportRepo {
  constructor(private readonly pool: Pool) {}

  /** バッチが生成成功時に呼ぶ。再生成の場合はdraftに戻し、承認/送信履歴をクリアする。 */
  async upsertDraft(customerCode: string, reportPeriod: string, input: { filePath: string }): Promise<MonthlyReport> {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO monthly_reports (customer_code, report_period, status, file_path, generated_at)
       VALUES ($1, $2, 'draft', $3, now())
       ON CONFLICT (customer_code, report_period) DO UPDATE
         SET status = 'draft', file_path = EXCLUDED.file_path, generated_at = now(),
             error_message = NULL, approved_by = NULL, approved_at = NULL, sent_at = NULL
       RETURNING ${SELECT_COLUMNS}`,
      [customerCode, reportPeriod, input.filePath],
    );
    const row = rows[0];
    if (!row) throw new Error('MonthlyReportRepo.upsertDraft: insert returned no row');
    return mapRow(row);
  }

  /** バッチが生成失敗時に呼ぶ。 */
  async markFailed(customerCode: string, reportPeriod: string, errorMessage: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO monthly_reports (customer_code, report_period, status, error_message)
       VALUES ($1, $2, 'failed', $3)
       ON CONFLICT (customer_code, report_period) DO UPDATE
         SET status = 'failed', error_message = EXCLUDED.error_message`,
      [customerCode, reportPeriod, errorMessage],
    );
  }

  async listByStatus(
    status: MonthlyReportStatus | undefined,
    opts: { limit: number; offset: number },
  ): Promise<{ items: MonthlyReport[]; total: number }> {
    const params: unknown[] = [];
    let where = '';
    if (status) {
      params.push(status);
      where = `WHERE status = $${params.length}`;
    }

    const { rows: countRows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM monthly_reports ${where}`,
      params,
    );
    const total = Number(countRows[0]?.count ?? 0);

    params.push(opts.limit, opts.offset);
    const { rows } = await this.pool.query<Row>(
      `SELECT ${SELECT_COLUMNS} FROM monthly_reports
       ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return { items: rows.map(mapRow), total };
  }

  async findById(id: string): Promise<MonthlyReport | null> {
    const { rows } = await this.pool.query<Row>(
      `SELECT ${SELECT_COLUMNS} FROM monthly_reports WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row ? mapRow(row) : null;
  }

  async markApproved(id: string, approvedBy: string): Promise<void> {
    await this.pool.query(
      "UPDATE monthly_reports SET status = 'approved', approved_by = $1, approved_at = now() WHERE id = $2",
      [approvedBy, id],
    );
  }

  /** 送信成功時。承認操作(markApproved)とは分離し、送信失敗時はapprovedのまま残せるようにする。 */
  async markSent(id: string): Promise<void> {
    await this.pool.query("UPDATE monthly_reports SET status = 'sent', sent_at = now() WHERE id = $1", [id]);
  }

  async markSendFailed(id: string, errorMessage: string): Promise<void> {
    await this.pool.query('UPDATE monthly_reports SET error_message = $1 WHERE id = $2', [errorMessage, id]);
  }
}

function mapRow(row: Row): MonthlyReport {
  return {
    id: row.id,
    customerCode: row.customer_code,
    reportPeriod: row.report_period,
    status: row.status,
    filePath: row.file_path,
    errorMessage: row.error_message,
    generatedAt: row.generated_at,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    sentAt: row.sent_at,
    createdAt: row.created_at,
  };
}
