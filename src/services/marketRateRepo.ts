import type { Pool } from 'pg';
import type { EstimateCategory } from '../domain/costEstimation';

export interface MarketRate {
  id: string;
  category: EstimateCategory;
  itemName: string;
  unit: string;
  priceLow: number;
  priceHigh: number;
  priceRecommended: number | null;
  sourceNote: string | null;
  isActive: boolean;
  updatedAt: string;
}

export interface MarketRateInput {
  category: EstimateCategory;
  itemName: string;
  unit: string;
  priceLow: number;
  priceHigh: number;
  priceRecommended: number | null;
  sourceNote: string | null;
}

interface Row {
  id: string;
  category: EstimateCategory;
  item_name: string;
  unit: string;
  price_low: string;
  price_high: string;
  price_recommended: string | null;
  source_note: string | null;
  is_active: boolean;
  updated_at: string;
}

/** market_rates（相場マスタ）への問い合わせを一手に引き受けるリポジトリ。customerApplicationRepo.tsと同じ構造。 */
export class MarketRateRepo {
  constructor(private readonly pool: Pool) {}

  async list(opts: { category?: EstimateCategory; includeInactive?: boolean }): Promise<MarketRate[]> {
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
      `SELECT id, category, item_name, unit, price_low, price_high, price_recommended, source_note, is_active, updated_at
       FROM market_rates
       ${where}
       ORDER BY category, item_name`,
      params,
    );
    return rows.map(mapRow);
  }

  async findById(id: string): Promise<MarketRate | null> {
    const { rows } = await this.pool.query<Row>(
      `SELECT id, category, item_name, unit, price_low, price_high, price_recommended, source_note, is_active, updated_at
       FROM market_rates WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row ? mapRow(row) : null;
  }

  async create(input: MarketRateInput): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO market_rates (category, item_name, unit, price_low, price_high, price_recommended, source_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [input.category, input.itemName, input.unit, input.priceLow, input.priceHigh, input.priceRecommended, input.sourceNote],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('MarketRateRepo.create: insert returned no id');
    return id;
  }

  /** 存在しないidの場合はfalseを返す（呼び出し側で404にする）。 */
  async update(id: string, input: MarketRateInput & { isActive: boolean }): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE market_rates
       SET category = $1, item_name = $2, unit = $3, price_low = $4, price_high = $5,
           price_recommended = $6, source_note = $7, is_active = $8, updated_at = now()
       WHERE id = $9`,
      [
        input.category,
        input.itemName,
        input.unit,
        input.priceLow,
        input.priceHigh,
        input.priceRecommended,
        input.sourceNote,
        input.isActive,
        id,
      ],
    );
    return (rowCount ?? 0) > 0;
  }

  /** CSV再取込（import_market_rates.ts）専用。(category, item_name, unit)で再実行安全にupsertする。 */
  async upsertFromImport(input: MarketRateInput): Promise<{ id: string; created: boolean }> {
    const { rows } = await this.pool.query<{ id: string; created: boolean }>(
      `INSERT INTO market_rates (category, item_name, unit, price_low, price_high, price_recommended, source_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (category, item_name, unit) DO UPDATE
         SET price_low = EXCLUDED.price_low,
             price_high = EXCLUDED.price_high,
             price_recommended = EXCLUDED.price_recommended,
             source_note = EXCLUDED.source_note,
             is_active = true,
             updated_at = now()
       RETURNING id, (xmax = 0) AS created`,
      [input.category, input.itemName, input.unit, input.priceLow, input.priceHigh, input.priceRecommended, input.sourceNote],
    );
    const row = rows[0];
    if (!row) throw new Error('MarketRateRepo.upsertFromImport: insert returned no row');
    return row;
  }
}

function mapRow(row: Row): MarketRate {
  return {
    id: row.id,
    category: row.category,
    itemName: row.item_name,
    unit: row.unit,
    priceLow: Number(row.price_low),
    priceHigh: Number(row.price_high),
    priceRecommended: row.price_recommended !== null ? Number(row.price_recommended) : null,
    sourceNote: row.source_note,
    isActive: row.is_active,
    updatedAt: row.updated_at,
  };
}
