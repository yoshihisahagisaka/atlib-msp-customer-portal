import { Router } from 'express';
import { z } from 'zod';
import type { CustomerApplicationRepo, ApplicationReviewStatus } from '../services/customerApplicationRepo';

const reviewStatusSchema = z.enum(['new', 'contacted', 'scheduled', 'closed']);

const listQuerySchema = z.object({
  status: reviewStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const statusUpdateSchema = z.object({
  status: reviewStatusSchema,
});

/** requireAdminAuthの配下でマウントされる前提（server.ts側で適用）。adminIsmsDiagnostic.tsと同じ構造。 */
export function createAdminCustomerApplicationsRouter(repo: CustomerApplicationRepo): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query' });
      return;
    }
    const { items, total } = await repo.listApplications({
      status: parsed.data.status,
      limit: parsed.data.limit ?? 50,
      offset: parsed.data.offset ?? 0,
    });
    res.json({ items, total });
  });

  router.get('/:id', async (req, res) => {
    const item = await repo.findById(req.params.id);
    if (!item) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(item);
  });

  router.patch('/:id/status', async (req, res) => {
    const parsed = statusUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const updated = await repo.updateReviewStatus(req.params.id, parsed.data.status as ApplicationReviewStatus);
    if (!updated) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.status(204).end();
  });

  return router;
}
