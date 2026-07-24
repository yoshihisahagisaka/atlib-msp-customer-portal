import { Router } from 'express';
import { z } from 'zod';
import type { ReportSettingsRepo } from '../services/reportSettingsRepo';

const upsertSchema = z.object({
  wanIfIn: z.string().min(1).optional(),
  wanIfOut: z.string().min(1).optional(),
});

/** requireAdminAuthの配下でマウントされる前提(server.ts側で適用)。 */
export function createAdminReportSettingsRouter(reportSettingsRepo: ReportSettingsRepo): Router {
  const router = Router();

  router.get('/:customerCode', async (req, res) => {
    const settings = await reportSettingsRepo.findByCustomerCode(req.params.customerCode);
    res.json(settings ?? { customerCode: req.params.customerCode, wanIfIn: null, wanIfOut: null, updatedAt: null });
  });

  router.put('/:customerCode', async (req, res) => {
    const parsed = upsertSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
      return;
    }
    const settings = await reportSettingsRepo.upsert(req.params.customerCode, {
      wanIfIn: parsed.data.wanIfIn ?? null,
      wanIfOut: parsed.data.wanIfOut ?? null,
    });
    res.json(settings);
  });

  return router;
}
