import type { Pool } from 'pg';
import type { EstimateCategory } from '../domain/costEstimation';

export interface EstimatePrecondition {
  id: string;
  category: EstimateCategory;
  label: string;
  sortOrder: number;
  isActive: boolean;
  updatedAt: string;
}

interface Row {
  id: string;
  category: EstimateCategory;
  label: string;
  sort_order: number;
  is_active: boolean;
  updated_at: string;
}

/** estimate_preconditions（前提条件マスタ）への問い合わせを一手に引き受けるリポジトリ。marketRateRepo.tsと同じ構造。 */
export class EstimatePreconditionRepo {
  constructor(private readonly pool: Pool) {}

  async list(opts: { category?: EstimateCategory; includeInactive?: boolean }): Promise<EstimatePrecondition[]> {
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (opts.category) {
      params.push(opts.category);
      conditions.push(`category = $${params.length}`);
    }
    if (!opts.includeInactive) {
      conditions.push('is_active = true');
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await this.pool.query<Row>(
      `SELECT id, category, label, sort_order, is_active, updated_at
       FROM estimate_preconditions
       ${where}
       ORDER BY category, sort_order, label`,
      params,
    );
    return rows.map(mapRow);
  }

  async create(input: { category: EstimateCategory; label: string; sortOrder: number }): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO estimate_preconditions (category, label, sort_order)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [input.category, input.label, input.sortOrder],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('EstimatePreconditionRepo.create: insert returned no id');
    return id;
  }

  /** 存在しないidの場合はfalseを返す（呼び出し側で404にする）。 */
  async update(id: string, input: { label: string; sortOrder: number; isActive: boolean }): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE estimate_preconditions
       SET label = $1, sort_order = $2, is_active = $3, updated_at = now()
       WHERE id = $4`,
      [input.label, input.sortOrder, input.isActive, id],
    );
    return (rowCount ?? 0) > 0;
  }
}

function mapRow(row: Row): EstimatePrecondition {
  return {
    id: row.id,
    category: row.category,
    label: row.label,
    sortOrder: row.sort_order,
    isActive: row.is_active,
    updatedAt: row.updated_at,
  };
}
