import { Router } from 'express';
import { z } from 'zod';
import type { EstimatePreconditionRepo } from '../services/estimatePreconditionRepo';

const categorySchema = z.enum(['network', 'server', 'kitting', 'dev', 'other']);

const listQuerySchema = z.object({
  category: categorySchema.optional(),
  includeInactive: z.coerce.boolean().optional(),
});

const createSchema = z.object({
  category: categorySchema,
  label: z.string().min(1).max(300),
  sortOrder: z.number().int().optional(),
});

const updateSchema = z.object({
  label: z.string().min(1).max(300),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
});

/** requireAdminAuthの配下でマウントされる前提（server.ts側で適用）。adminMarketRates.tsと同じ構造。 */
export function createAdminEstimatePreconditionsRouter(repo: EstimatePreconditionRepo): Router {
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

  router.post('/', async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const id = await repo.create({ ...parsed.data, sortOrder: parsed.data.sortOrder ?? 0 });
    res.status(201).json({ id });
  });

  router.put('/:id', async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
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
