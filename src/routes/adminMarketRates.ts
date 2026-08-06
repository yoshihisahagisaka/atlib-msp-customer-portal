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
});

const marketRateUpdateSchema = marketRateInputSchema.extend({
  isActive: z.boolean(),
});

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
    if (
      parsed.data.priceRecommended !== null &&
      (parsed.data.priceRecommended < parsed.data.priceLow || parsed.data.priceRecommended > parsed.data.priceHigh)
    ) {
      res.status(400).json({ error: 'priceRecommended must be between priceLow and priceHigh' });
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
    const updated = await repo.update(req.params.id, parsed.data);
    if (!updated) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.status(204).end();
  });

  return router;
}
