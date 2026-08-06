export type EstimateCategory = 'network' | 'server' | 'kitting' | 'dev' | 'other';
export type LineItemCostType = 'fixed' | 'variable';
export type MarketRateFlagLevel = 'no_reference' | 'below_low' | 'below_recommended' | 'ok' | 'above_high';

export interface MarketRateRef {
  priceLow: number;
  priceHigh: number;
  priceRecommended: number | null;
}

export interface LineItemForCalc {
  costType: LineItemCostType;
  quantity: number;
  unitCost: number;
  riskCoefficientOverride: number | null;
}

/** 固定費はquantity×unit_costのみ。変動費のみリスク係数（override優先、無ければ見積既定値）を掛ける。 */
export function computeLineItemAdjustedAmount(
  item: LineItemForCalc,
  estimateDefaultRiskCoefficient: number,
): number {
  const base = item.quantity * item.unitCost;
  if (item.costType === 'fixed') return base;
  const coefficient = item.riskCoefficientOverride ?? estimateDefaultRiskCoefficient;
  return base * coefficient;
}

export interface EstimateTotals {
  fixedTotal: number;
  variableRawTotal: number;
  variableAdjustedTotal: number;
  grandTotal: number;
}

/** 読み取り時に都度計算する（DBには保存しない＝陳腐化防止）。 */
export function computeEstimateTotals(
  lineItems: LineItemForCalc[],
  estimateDefaultRiskCoefficient: number,
): EstimateTotals {
  let fixedTotal = 0;
  let variableRawTotal = 0;
  let variableAdjustedTotal = 0;

  for (const item of lineItems) {
    const base = item.quantity * item.unitCost;
    if (item.costType === 'fixed') {
      fixedTotal += base;
    } else {
      variableRawTotal += base;
      variableAdjustedTotal += computeLineItemAdjustedAmount(item, estimateDefaultRiskCoefficient);
    }
  }

  return {
    fixedTotal,
    variableRawTotal,
    variableAdjustedTotal,
    grandTotal: fixedTotal + variableAdjustedTotal,
  };
}

export interface MarketRateFlagResult {
  level: MarketRateFlagLevel;
  deltaFromLow: number | null;
  deltaFromRecommended: number | null;
}

/**
 * 相場との突合判定。安値傾向の是正が本ツールの主目的のため、price_lowを下回る場合を
 * 明確に区別する。marketRateがnullの場合（相場マスタ未登録）は判定不能として扱う。
 * 将来AIによる補助判定を追加する場合、この関数のシグネチャに任意の第3引数（AI提案）を
 * 足す形で拡張できるよう、単一責務のまま保つ。
 */
export function evaluateMarketRateFlag(unitCost: number, marketRate: MarketRateRef | null): MarketRateFlagResult {
  if (!marketRate) {
    return { level: 'no_reference', deltaFromLow: null, deltaFromRecommended: null };
  }

  const deltaFromLow = unitCost - marketRate.priceLow;
  const deltaFromRecommended =
    marketRate.priceRecommended !== null ? unitCost - marketRate.priceRecommended : null;

  let level: MarketRateFlagLevel;
  if (unitCost < marketRate.priceLow) {
    level = 'below_low';
  } else if (unitCost > marketRate.priceHigh) {
    level = 'above_high';
  } else if (marketRate.priceRecommended !== null && unitCost < marketRate.priceRecommended) {
    level = 'below_recommended';
  } else {
    level = 'ok';
  }

  return { level, deltaFromLow, deltaFromRecommended };
}
