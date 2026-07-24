import type { Pool } from 'pg';

export interface OpsHistoryEntryInput {
  customerCode: string;
  occurredAt: string;
  category: string;
  description?: string;
  operator: string;
  minutesSpent: number;
  planQuotaConsumed: boolean;
}

export interface OpsHistoryEntry {
  id: string;
  customerCode: string;
  occurredAt: string;
  category: string;
  description: string | null;
  operator: string;
  minutesSpent: number;
  planQuotaConsumed: boolean;
  createdAt: string;
}

interface Row {
  id: string;
  customer_code: string;
  occurred_at: string;
  category: string;
  description: string | null;
  operator: string;
  minutes_spent: number;
  plan_quota_consumed: boolean;
  created_at: string;
}

/**
 * ops_history への問い合わせを一手に引き受けるリポジトリ。
 * customer_codeで直接扱う（customersのidではなく）。月次レポート生成バッチが
 * customer_codeのみを持って呼び出す運用に合わせるため。
 */
export class OpsHistoryRepo {
  constructor(private readonly pool: Pool) {}

  async create(input: OpsHistoryEntryInput): Promise<OpsHistoryEntry> {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO ops_history (customer_code, occurred_at, category, description, operator, minutes_spent, plan_quota_consumed)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, customer_code, occurred_at, category, description, operator, minutes_spent, plan_quota_consumed, created_at`,
      [
        input.customerCode,
        input.occurredAt,
        input.category,
        input.description ?? null,
        input.operator,
        input.minutesSpent,
        input.planQuotaConsumed,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('OpsHistoryRepo.create: insert returned no row');
    return mapRow(row);
  }

  async listByCustomer(
    customerCode: string,
    opts: { limit: number; offset: number },
  ): Promise<{ items: OpsHistoryEntry[]; total: number }> {
    const { rows: countRows } = await this.pool.query<{ count: string }>(
      'SELECT COUNT(*) FROM ops_history WHERE customer_code = $1',
      [customerCode],
    );
    const total = Number(countRows[0]?.count ?? 0);

    const { rows } = await this.pool.query<Row>(
      `SELECT id, customer_code, occurred_at, category, description, operator, minutes_spent, plan_quota_consumed, created_at
       FROM ops_history
       WHERE customer_code = $1
       ORDER BY occurred_at DESC
       LIMIT $2 OFFSET $3`,
      [customerCode, opts.limit, opts.offset],
    );

    return { items: rows.map(mapRow), total };
  }

  /**
   * 対象月（periodYearMonthは 'YYYY-MM'）内の対応履歴を発生日時の昇順で全件取得する。
   * 月次レポートのスライド7(運用対応履歴)に流し込む用途(件数上限を設けない)。
   */
  async listByCustomerAndPeriod(customerCode: string, periodYearMonth: string): Promise<OpsHistoryEntry[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT id, customer_code, occurred_at, category, description, operator, minutes_spent, plan_quota_consumed, created_at
       FROM ops_history
       WHERE customer_code = $1
         AND date_trunc('month', occurred_at) = date_trunc('month', $2::date)
       ORDER BY occurred_at ASC`,
      [customerCode, `${periodYearMonth}-01`],
    );
    return rows.map(mapRow);
  }

  /**
   * 対象月（periodYearMonthは 'YYYY-MM'）内で plan_quota_consumed=true の対応件数を集計する。
   * リモート運用プランの「月4回まで」枠の消化状況確認に使う。
   */
  async quotaConsumedCount(customerCode: string, periodYearMonth: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM ops_history
       WHERE customer_code = $1
         AND plan_quota_consumed = true
         AND date_trunc('month', occurred_at) = date_trunc('month', $2::date)`,
      [customerCode, `${periodYearMonth}-01`],
    );
    return Number(rows[0]?.count ?? 0);
  }
}

function mapRow(row: Row): OpsHistoryEntry {
  return {
    id: row.id,
    customerCode: row.customer_code,
    occurredAt: row.occurred_at,
    category: row.category,
    description: row.description,
    operator: row.operator,
    minutesSpent: row.minutes_spent,
    planQuotaConsumed: row.plan_quota_consumed,
    createdAt: row.created_at,
  };
}
