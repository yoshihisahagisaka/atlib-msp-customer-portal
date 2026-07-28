import { Router } from 'express';
import { z } from 'zod';
import type { ReportSettingsRepo } from '../services/reportSettingsRepo';
import type { CustomerRepo } from '../services/customerRepo';
import type { ZabbixClient } from '../services/zabbixClient';

const upsertSchema = z.object({
  wanIfIn: z.string().min(1).optional(),
  wanIfOut: z.string().min(1).optional(),
});

/** requireAdminAuthの配下でマウントされる前提(server.ts側で適用)。 */
export function createAdminReportSettingsRouter(
  reportSettingsRepo: ReportSettingsRepo,
  customerRepo: CustomerRepo,
  zabbixClient: ZabbixClient,
): Router {
  const router = Router();

  router.get('/:customerCode', async (req, res) => {
    const settings = await reportSettingsRepo.findByCustomerCode(req.params.customerCode);
    res.json(settings ?? { customerCode: req.params.customerCode, wanIfIn: null, wanIfOut: null, updatedAt: null });
  });

  // WAN IN/OUTプルダウンの選択肢。顧客の全ホストグループ分をまとめて返す(グループが複数あっても
  // 選択肢のホスト名/インターフェース名で区別できるため、ここでは主グループを絞り込まない)。
  router.get('/:customerCode/wan-candidates', async (req, res) => {
    const customer = await customerRepo.findByCustomerCode(req.params.customerCode);
    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }
    const groupIds = await customerRepo.resolveHostgroupIds(customer.id);
    if (groupIds.length === 0) {
      res.json({ in: [], out: [] });
      return;
    }
    const candidates = await zabbixClient.getWanInterfaceCandidates(groupIds);
    res.json(candidates);
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
