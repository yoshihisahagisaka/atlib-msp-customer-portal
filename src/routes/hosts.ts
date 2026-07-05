import { Router } from 'express';
import { z } from 'zod';
import type { AuthService } from '../services/authService';
import type { CustomerRepo } from '../services/customerRepo';
import type { ZabbixClient, ZabbixHostDetail } from '../services/zabbixClient';
import { requireAuth } from '../middleware/auth';

const createSchema = z.object({
  name: z.string().min(1),
  ip: z.string().min(1),
  monitorType: z.enum(['icmp', 'snmp']),
  snmpCommunity: z.string().optional(),
});

const statusSchema = z.object({
  enabled: z.boolean(),
});

/** interfaces[0].type: '1'=Agent（ICMP流用）, '2'=SNMP。設計書の監視種別マッピングどおり。 */
function monitorTypeFromInterfaces(host: ZabbixHostDetail): 'icmp' | 'snmp' {
  const type = host.interfaces?.[0]?.type;
  return type === '2' ? 'snmp' : 'icmp';
}

export function createHostsRouter(
  authService: AuthService,
  customerRepo: CustomerRepo,
  zabbixClient: ZabbixClient,
): Router {
  const router = Router();
  router.use(requireAuth(authService));

  router.get('/', async (req, res) => {
    const groupIds = await customerRepo.resolveHostgroupIds(req.customerId!);
    const hosts = await zabbixClient.getHostsDetailed(groupIds);
    res.json(
      hosts.map((h) => ({
        id: h.hostid,
        name: h.name,
        ip: h.interfaces?.[0]?.ip ?? '',
        monitorType: monitorTypeFromInterfaces(h),
        enabled: h.status === '0',
      })),
    );
  });

  router.post('/', async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }

    const [groupIds, proxyHostId] = await Promise.all([
      customerRepo.resolveHostgroupIds(req.customerId!),
      customerRepo.getZabbixProxyId(req.customerId!),
    ]);

    const id = await zabbixClient.createHost({
      name: parsed.data.name,
      ip: parsed.data.ip,
      monitorType: parsed.data.monitorType,
      snmpCommunity: parsed.data.snmpCommunity,
      groupIds,
      proxyHostId,
    });
    res.status(201).json({ id });
  });

  router.put('/:id/status', async (req, res) => {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }

    const groupIds = await customerRepo.resolveHostgroupIds(req.customerId!);
    const owns = await zabbixClient.verifyHostOwnership(req.params.id, groupIds);
    if (!owns) {
      res.status(404).json({ error: 'Host not found' });
      return;
    }

    await zabbixClient.setHostStatus(req.params.id, parsed.data.enabled ? 0 : 1);
    res.status(204).end();
  });

  router.delete('/:id', async (req, res) => {
    const groupIds = await customerRepo.resolveHostgroupIds(req.customerId!);
    const owns = await zabbixClient.verifyHostOwnership(req.params.id, groupIds);
    if (!owns) {
      res.status(404).json({ error: 'Host not found' });
      return;
    }

    // 設計書どおり、削除は取り返しがつかない（トレンド/ヒストリも消える）ため、
    // フロントエンド側で2段階確認を必須とすること。バックエンドは無効化(status更新)との
    // 使い分けをフロントエンドに委ねる（このエンドポイントは常にhost.deleteを実行する）。
    await zabbixClient.deleteHost(req.params.id);
    res.status(204).end();
  });

  return router;
}
