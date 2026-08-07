import { Router } from 'express';
import { z } from 'zod';
import type { MarketRateRepo } from '../services/marketRateRepo';

const categorySchema = z.enum(['network', 'server', 'kitting', 'dev', 'other']);

const listQuerySchema = z.object({
  category: categorySchema.optional(),
  includeInactive: z.coerce.boolean().optional(),
});

const marketRateInputSchema = z.object({
  category: categorySchema,
  itemName: z.string().min(1).max(200),
  unit: z.string().min(1).max(50),
  priceLow: z.number().min(0),
  priceHigh: z.number().min(0),
  priceRecommended: z.number().min(0).nullable(),
  sourceNote: z.string().max(500).nullable(),
  marketBaselineLow: z.number().min(0).nullable(),
  marketBaselineHigh: z.number().min(0).nullable(),
  marketBaselineRecommended: z.number().min(0).nullable(),
  marketResearchSource: z.string().max(500).nullable(),
  adjustmentCoefficient: z.number().positive().nullable(),
});

const marketRateUpdateSchema = marketRateInputSchema.extend({
  isActive: z.boolean(),
});

/**
 * POST/PUT共通のクロスフィールド検証。DB側のCHECKはNULLを許容する緩いガードのため、
 * 「上限だけ入力して下限が空」のような片手落ちや範囲外の推奨値はここで弾く。
 */
function validateCrossFields(data: z.infer<typeof marketRateInputSchema>): string | null {
  if (data.priceHigh < data.priceLow) {
    return 'priceHigh must be >= priceLow';
  }
  if (
    data.priceRecommended !== null &&
    (data.priceRecommended < data.priceLow || data.priceRecommended > data.priceHigh)
  ) {
    return 'priceRecommended must be between priceLow and priceHigh';
  }

  const hasAnyBaseline =
    data.marketBaselineLow !== null || data.marketBaselineHigh !== null || data.marketBaselineRecommended !== null;
  if (hasAnyBaseline) {
    if (data.marketBaselineLow === null || data.marketBaselineHigh === null) {
      return 'marketBaselineLow and marketBaselineHigh must both be set when recording a baseline';
    }
    if (data.marketBaselineHigh < data.marketBaselineLow) {
      return 'marketBaselineHigh must be >= marketBaselineLow';
    }
    if (
      data.marketBaselineRecommended !== null &&
      (data.marketBaselineRecommended < data.marketBaselineLow || data.marketBaselineRecommended > data.marketBaselineHigh)
    ) {
      return 'marketBaselineRecommended must be between marketBaselineLow and marketBaselineHigh';
    }
  }

  return null;
}

/** requireAdminAuthの配下でマウントされる前提（server.ts側で適用）。adminCustomerApplications.tsと同じ構造。 */
export function createAdminMarketRatesRouter(repo: MarketRateRepo): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query' });
      return;
    }
    const items = await repo.list(parsed.data);
    res.json({ items });
  });

  router.get('/:id', async (req, res) => {
    const item = await repo.findById(req.params.id);
    if (!item) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(item);
  });

  router.post('/', async (req, res) => {
    const parsed = marketRateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const validationError = validateCrossFields(parsed.data);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }
    const id = await repo.create(parsed.data);
    res.status(201).json({ id });
  });

  router.put('/:id', async (req, res) => {
    const parsed = marketRateUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const validationError = validateCrossFields(parsed.data);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }
    const updated = await repo.update(req.params.id, parsed.data);
    if (!updated) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.status(204).end();
  });

  return router;
}
