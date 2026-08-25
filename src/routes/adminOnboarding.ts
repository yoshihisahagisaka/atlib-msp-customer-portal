import { Router } from 'express';
import { z } from 'zod';
import { onboardCustomer, DuplicateCustomerCodeError, type OnboardCustomerDeps } from '../services/onboardingService';
import { triggerDiscoverySetupJob, type CloudRunJobConfig } from '../services/cloudRunJobTrigger';

const onboardingSchema = z.object({
  customerCode: z.string().min(1).max(50),
  companyName: z.string().min(1).max(200),
  email: z.string().email(),
  proxyId: z.string().max(50).optional(),
  ipRange: z.string().max(100).optional(),
});

/**
 * requireStaffAuthの配下でマウントされる前提（server.ts側で適用）。adminCustomerApplications.tsと同じ構造。
 * 新規顧客のポータル登録（onboardCustomer）＋Zabbixディスカバリ設定（Cloud Run Job）を1回のリクエストで
 * 実行する。管理画面からのgcloud compute ssh依存を無くすための窓口（詳細は
 * docs/運用手順書_顧客オンボーディング統合フロー.md 手順2・3を参照）。
 */
export function createAdminOnboardingRouter(deps: OnboardCustomerDeps, jobConfig: CloudRunJobConfig): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const parsed = onboardingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }

    let result;
    try {
      // eslint-disable-next-line no-console
      result = await onboardCustomer(deps, parsed.data, (msg) => console.log(msg));
    } catch (err) {
      if (err instanceof DuplicateCustomerCodeError) {
        res.status(409).json({ error: err.message });
        return;
      }
      // eslint-disable-next-line no-console
      console.error('onboarding failed:', err);
      res.status(500).json({ error: 'オンボーディング処理に失敗しました' });
      return;
    }

    // ディスカバリ設定Job起動はbest-effort。ipRange未指定時は自動スキップ(create_customer.tsの
    // 既存仕様=proxy-id/ip-rangeは任意、を踏襲)。失敗してもオンボーディング自体は成功として扱い、
    // 手動setup_discovery.py実行への切り替えを促す。
    let discoveryJobTriggered = false;
    let discoveryJobError: string | undefined;
    if (parsed.data.ipRange) {
      try {
        await triggerDiscoverySetupJob(jobConfig, {
          customerCode: parsed.data.customerCode,
          companyName: parsed.data.companyName,
          ipRange: parsed.data.ipRange,
          proxyId: parsed.data.proxyId,
        });
        discoveryJobTriggered = true;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('discovery job trigger failed:', err);
        discoveryJobError = 'ディスカバリ設定ジョブの起動に失敗しました。手動でsetup_discovery.pyを実行してください。';
      }
    }

    res.status(201).json({ ...result, discoveryJobTriggered, discoveryJobError });
  });

  return router;
}
