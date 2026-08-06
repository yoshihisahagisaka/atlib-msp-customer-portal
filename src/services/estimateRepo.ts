import type { Pool, PoolClient } from 'pg';
import type { EstimateCategory, LineItemCostType, EstimateTotals, MarketRateFlagResult } from '../domain/costEstimation';
import { computeEstimateTotals, computeLineItemAdjustedAmount, evaluateMarketRateFlag } from '../domain/costEstimation';

export type EstimateStatus = 'draft' | 'confirmed' | 'archived';

export interface EstimateListItem {
  id: string;
  title: string;
  customerName: string | null;
  category: EstimateCategory;
  status: EstimateStatus;
  grandTotal: number;
  createdAt: string;
}

export interface EstimateHeaderInput {
  title: string;
  customerName: string | null;
  category: EstimateCategory;
  defaultRiskCoefficient: number;
  notes: string | null;
  createdBy: string | null;
}

export interface EstimateLineItemInput {
  itemName: string;
  costType: LineItemCostType;
  unit: string | null;
  quantity: number;
  unitCost: number;
  riskCoefficientOverride: number | null;
  marketRateId: string | null;
  sortOrder: number;
  memo: string | null;
}

export interface EstimateSelectedPreconditionInput {
  preconditionId: string | null;
  label: string;
  isAdHoc: boolean;
  sortOrder: number;
}

export interface EstimateFullInput extends EstimateHeaderInput {
  lineItems: EstimateLineItemInput[];
  selectedPreconditions: EstimateSelectedPreconditionInput[];
}

export interface EstimateLineItemDetail extends EstimateLineItemInput {
  id: string;
  adjustedAmount: number;
  marketRate: { priceLow: number; priceHigh: number; priceRecommended: number | null } | null;
  flag: MarketRateFlagResult;
}

export interface EstimateSelectedPreconditionDetail extends EstimateSelectedPreconditionInput {
  id: string;
}

export interface EstimateDetail extends EstimateHeaderInput {
  id: string;
  status: EstimateStatus;
  createdAt: string;
  updatedAt: string;
  lineItems: EstimateLineItemDetail[];
  selectedPreconditions: EstimateSelectedPreconditionDetail[];
  totals: EstimateTotals;
}

interface HeaderRow {
  id: string;
  title: string;
  customer_name: string | null;
  category: EstimateCategory;
  status: EstimateStatus;
  default_risk_coefficient: string;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface LineItemForTotalsRow {
  estimate_id: string;
  cost_type: LineItemCostType;
  quantity: string;
  unit_cost: string;
  risk_coefficient_override: string | null;
}

interface LineItemDetailRow {
  id: string;
  cost_type: LineItemCostType;
  item_name: string;
  unit: string | null;
  quantity: string;
  unit_cost: string;
  risk_coefficient_override: string | null;
  market_rate_id: string | null;
  sort_order: number;
  memo: string | null;
  mr_price_low: string | null;
  mr_price_high: string | null;
  mr_price_recommended: string | null;
}

interface PreconditionRow {
  id: string;
  precondition_id: string | null;
  label: string;
  is_ad_hoc: boolean;
  sort_order: number;
}

/**
 * estimates / estimate_line_items / estimate_selected_preconditions への問い合わせを一手に引き受けるリポジトリ。
 * ヘッダ・明細・前提条件を1つの見積として原子的に書き込む必要があるため、createFull/updateFullは
 * pool.connect() + BEGIN/COMMIT/ROLLBACKでトランザクションを取る（migrations/runner.tsと同じ形）。
 * 本リポジトリで初めて複数テーブルにまたがる原子的書き込みを扱う。
 */
export class EstimateRepo {
  constructor(private readonly pool: Pool) {}

  async list(opts: {
    status?: EstimateStatus;
    category?: EstimateCategory;
    limit: number;
    offset: number;
  }): Promise<{ items: EstimateListItem[]; total: number }> {
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (opts.status) {
      params.push(opts.status);
      conditions.push(`status = $${params.length}`);
    }
    if (opts.category) {
      params.push(opts.category);
      conditions.push(`category = $${params.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows: countRows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM estimates ${where}`,
      params,
    );
    const total = Number(countRows[0]?.count ?? 0);

    params.push(opts.limit, opts.offset);
    const { rows: headerRows } = await this.pool.query<HeaderRow>(
      `SELECT id, title, customer_name, category, status, default_risk_coefficient, notes, created_by, created_at, updated_at
       FROM estimates
       ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    if (headerRows.length === 0) return { items: [], total };

    const ids = headerRows.map((r) => r.id);
    const { rows: lineItemRows } = await this.pool.query<LineItemForTotalsRow>(
      `SELECT estimate_id, cost_type, quantity, unit_cost, risk_coefficient_override
       FROM estimate_line_items WHERE estimate_id = ANY($1::uuid[])`,
      [ids],
    );

    const itemsByEstimate = new Map<
      string,
      { costType: LineItemCostType; quantity: number; unitCost: number; riskCoefficientOverride: number | null }[]
    >();
    for (const row of lineItemRows) {
      const list = itemsByEstimate.get(row.estimate_id) ?? [];
      list.push({
        costType: row.cost_type,
        quantity: Number(row.quantity),
        unitCost: Number(row.unit_cost),
        riskCoefficientOverride: row.risk_coefficient_override !== null ? Number(row.risk_coefficient_override) : null,
      });
      itemsByEstimate.set(row.estimate_id, list);
    }

    const items = headerRows.map((row) => {
      const lineItems = itemsByEstimate.get(row.id) ?? [];
      const totals = computeEstimateTotals(lineItems, Number(row.default_risk_coefficient));
      return {
        id: row.id,
        title: row.title,
        customerName: row.customer_name,
        category: row.category,
        status: row.status,
        grandTotal: totals.grandTotal,
        createdAt: row.created_at,
      };
    });

    return { items, total };
  }

  async findById(id: string): Promise<EstimateDetail | null> {
    const { rows: headerRows } = await this.pool.query<HeaderRow>(
      `SELECT id, title, customer_name, category, status, default_risk_coefficient, notes, created_by, created_at, updated_at
       FROM estimates WHERE id = $1`,
      [id],
    );
    const header = headerRows[0];
    if (!header) return null;

    const { rows: lineItemRows } = await this.pool.query<LineItemDetailRow>(
      `SELECT li.id, li.cost_type, li.item_name, li.unit, li.quantity, li.unit_cost,
              li.risk_coefficient_override, li.market_rate_id, li.sort_order, li.memo,
              mr.price_low AS mr_price_low, mr.price_high AS mr_price_high, mr.price_recommended AS mr_price_recommended
       FROM estimate_line_items li
       LEFT JOIN market_rates mr ON mr.id = li.market_rate_id
       WHERE li.estimate_id = $1
       ORDER BY li.sort_order, li.created_at`,
      [id],
    );

    const { rows: preconditionRows } = await this.pool.query<PreconditionRow>(
      `SELECT id, precondition_id, label, is_ad_hoc, sort_order
       FROM estimate_selected_preconditions
       WHERE estimate_id = $1
       ORDER BY sort_order, created_at`,
      [id],
    );

    const defaultRiskCoefficient = Number(header.default_risk_coefficient);

    const lineItems: EstimateLineItemDetail[] = lineItemRows.map((row) => {
      const forCalc = {
        costType: row.cost_type,
        quantity: Number(row.quantity),
        unitCost: Number(row.unit_cost),
        riskCoefficientOverride: row.risk_coefficient_override !== null ? Number(row.risk_coefficient_override) : null,
      };
      const marketRate =
        row.mr_price_low !== null
          ? {
              priceLow: Number(row.mr_price_low),
              priceHigh: Number(row.mr_price_high),
              priceRecommended: row.mr_price_recommended !== null ? Number(row.mr_price_recommended) : null,
            }
          : null;
      return {
        id: row.id,
        itemName: row.item_name,
        costType: forCalc.costType,
        unit: row.unit,
        quantity: forCalc.quantity,
        unitCost: forCalc.unitCost,
        riskCoefficientOverride: forCalc.riskCoefficientOverride,
        marketRateId: row.market_rate_id,
        sortOrder: row.sort_order,
        memo: row.memo,
        adjustedAmount: computeLineItemAdjustedAmount(forCalc, defaultRiskCoefficient),
        marketRate,
        flag: evaluateMarketRateFlag(forCalc.unitCost, marketRate),
      };
    });

    const selectedPreconditions: EstimateSelectedPreconditionDetail[] = preconditionRows.map((row) => ({
      id: row.id,
      preconditionId: row.precondition_id,
      label: row.label,
      isAdHoc: row.is_ad_hoc,
      sortOrder: row.sort_order,
    }));

    const totals = computeEstimateTotals(
      lineItems.map((li) => ({
        costType: li.costType,
        quantity: li.quantity,
        unitCost: li.unitCost,
        riskCoefficientOverride: li.riskCoefficientOverride,
      })),
      defaultRiskCoefficient,
    );

    return {
      id: header.id,
      title: header.title,
      customerName: header.customer_name,
      category: header.category,
      status: header.status,
      defaultRiskCoefficient,
      notes: header.notes,
      createdBy: header.created_by,
      createdAt: header.created_at,
      updatedAt: header.updated_at,
      lineItems,
      selectedPreconditions,
      totals,
    };
  }

  async createFull(input: EstimateFullInput): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO estimates (title, customer_name, category, default_risk_coefficient, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [input.title, input.customerName, input.category, input.defaultRiskCoefficient, input.notes, input.createdBy],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error('EstimateRepo.createFull: insert returned no id');

      await insertLineItems(client, id, input.lineItems);
      await insertSelectedPreconditions(client, id, input.selectedPreconditions);

      await client.query('COMMIT');
      return id;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** ヘッダ・明細・前提条件をまとめて全置換する（既存の明細/前提条件は一旦削除して再作成）。存在しないidの場合はfalseを返す。 */
  async updateFull(id: string, input: EstimateFullInput): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(
        `UPDATE estimates
         SET title = $1, customer_name = $2, category = $3, default_risk_coefficient = $4, notes = $5, updated_at = now()
         WHERE id = $6`,
        [input.title, input.customerName, input.category, input.defaultRiskCoefficient, input.notes, id],
      );
      if ((rowCount ?? 0) === 0) {
        await client.query('ROLLBACK');
        return false;
      }

      await client.query('DELETE FROM estimate_line_items WHERE estimate_id = $1', [id]);
      await client.query('DELETE FROM estimate_selected_preconditions WHERE estimate_id = $1', [id]);
      await insertLineItems(client, id, input.lineItems);
      await insertSelectedPreconditions(client, id, input.selectedPreconditions);

      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** 存在しないidの場合はfalseを返す（呼び出し側で404にする）。一覧画面の行内ステータス変更用。 */
  async updateStatus(id: string, status: EstimateStatus): Promise<boolean> {
    const { rowCount } = await this.pool.query('UPDATE estimates SET status = $1, updated_at = now() WHERE id = $2', [
      status,
      id,
    ]);
    return (rowCount ?? 0) > 0;
  }
}

async function insertLineItems(client: PoolClient, estimateId: string, items: EstimateLineItemInput[]): Promise<void> {
  for (const item of items) {
    await client.query(
      `INSERT INTO estimate_line_items
         (estimate_id, cost_type, item_name, unit, quantity, unit_cost, risk_coefficient_override, market_rate_id, sort_order, memo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        estimateId,
        item.costType,
        item.itemName,
        item.unit,
        item.quantity,
        item.unitCost,
        item.riskCoefficientOverride,
        item.marketRateId,
        item.sortOrder,
        item.memo,
      ],
    );
  }
}

async function insertSelectedPreconditions(
  client: PoolClient,
  estimateId: string,
  items: EstimateSelectedPreconditionInput[],
): Promise<void> {
  for (const item of items) {
    await client.query(
      `INSERT INTO estimate_selected_preconditions (estimate_id, precondition_id, label, is_ad_hoc, sort_order)
       VALUES ($1, $2, $3, $4, $5)`,
      [estimateId, item.preconditionId, item.label, item.isAdHoc, item.sortOrder],
    );
  }
}
