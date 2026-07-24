import { Router } from 'express';
import { z } from 'zod';
import type { CustomerRepo } from '../services/customerRepo';
import type { OpsHistoryRepo } from '../services/opsHistoryRepo';

const createSchema = z.object({
  customerCode: z.string().min(1),
  occurredAt: z.string().min(1), // ISO文字列。DB側でTIMESTAMPTZにキャストされる
  category: z.string().min(1),
  description: z.string().optional(),
  operator: z.string().min(1),
  minutesSpent: z.coerce.number().int().min(0),
  planQuotaConsumed: z.coerce.boolean(),
});

const listQuerySchema = z.object({
  customerCode: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const quotaQuerySchema = z.object({
  customerCode: z.string().min(1),
  period: z.string().regex(/^\d{4}-\d{2}$/, 'period must be YYYY-MM'),
});

/** requireAdminAuthの配下でマウントされる前提（server.ts側で適用）。 */
export function createAdminOpsHistoryRouter(opsHistoryRepo: OpsHistoryRepo, customerRepo: CustomerRepo): Router {
  const router = Router();

  // 入力フォームの顧客プルダウン用。
  router.get('/customers', async (_req, res) => {
    const customers = await customerRepo.listActive();
    res.json({ items: customers });
  });

  router.get('/', async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query' });
      return;
    }
    const { items, total } = await opsHistoryRepo.listByCustomer(parsed.data.customerCode, {
      limit: parsed.data.limit ?? 50,
      offset: parsed.data.offset ?? 0,
    });
    res.json({ items, total });
  });

  router.get('/quota-summary', async (req, res) => {
    const parsed = quotaQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query' });
      return;
    }
    const consumedCount = await opsHistoryRepo.quotaConsumedCount(parsed.data.customerCode, parsed.data.period);
    res.json({ consumedCount });
  });

  router.post('/', async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
      return;
    }
    const entry = await opsHistoryRepo.create(parsed.data);
    res.status(201).json(entry);
  });

  return router;
}
