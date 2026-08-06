import { Router } from 'express';
import { z } from 'zod';
import type { EstimateRepo, EstimateStatus } from '../services/estimateRepo';

const categorySchema = z.enum(['network', 'server', 'kitting', 'dev', 'other']);
const statusSchema = z.enum(['draft', 'confirmed', 'archived']);
const costTypeSchema = z.enum(['fixed', 'variable']);

const listQuerySchema = z.object({
  status: statusSchema.optional(),
  category: categorySchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const lineItemInputSchema = z.object({
  itemName: z.string().min(1).max(300),
  costType: costTypeSchema,
  unit: z.string().max(50).nullable(),
  quantity: z.number().min(0),
  unitCost: z.number().min(0),
  riskCoefficientOverride: z.number().gt(0).nullable(),
  marketRateId: z.string().uuid().nullable(),
  sortOrder: z.number().int(),
  memo: z.string().max(500).nullable(),
});

const selectedPreconditionInputSchema = z.object({
  preconditionId: z.string().uuid().nullable(),
  label: z.string().min(1).max(300),
  isAdHoc: z.boolean(),
  sortOrder: z.number().int(),
});

const estimateFullInputSchema = z.object({
  title: z.string().min(1).max(300),
  customerName: z.string().max(300).nullable(),
  category: categorySchema,
  defaultRiskCoefficient: z.number().gt(0),
  notes: z.string().max(2000).nullable(),
  createdBy: z.string().max(100).nullable(),
  lineItems: z.array(lineItemInputSchema).max(200),
  selectedPreconditions: z.array(selectedPreconditionInputSchema).max(100),
});

const statusUpdateSchema = z.object({
  status: statusSchema,
});

/** requireAdminAuthの配下でマウントされる前提（server.ts側で適用）。adminCustomerApplications.tsと同じ構造。 */
export function createAdminEstimatesRouter(repo: EstimateRepo): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query' });
      return;
    }
    const { items, total } = await repo.list({
      status: parsed.data.status,
      category: parsed.data.category,
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

  router.post('/', async (req, res) => {
    const parsed = estimateFullInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const id = await repo.createFull(parsed.data);
    res.status(201).json({ id });
  });

  router.put('/:id', async (req, res) => {
    const parsed = estimateFullInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const updated = await repo.updateFull(req.params.id, parsed.data);
    if (!updated) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.status(204).end();
  });

  router.patch('/:id/status', async (req, res) => {
    const parsed = statusUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const updated = await repo.updateStatus(req.params.id, parsed.data.status as EstimateStatus);
    if (!updated) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.status(204).end();
  });

  return router;
}
