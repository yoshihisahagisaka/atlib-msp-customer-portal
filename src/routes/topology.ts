import { Router } from 'express';
import type { AuthService } from '../services/authService';
import type { CustomerRepo } from '../services/customerRepo';
import type { ZabbixClient } from '../services/zabbixClient';
import { requireAuth } from '../middleware/auth';

export function createTopologyRouter(
  authService: AuthService,
  customerRepo: CustomerRepo,
  zabbixClient: ZabbixClient,
): Router {
  const router = Router();
  router.use(requireAuth(authService));

  router.get('/', async (req, res) => {
    const groupIds = await customerRepo.resolveHostgroupIds(req.customerId!);
    const hosts = await zabbixClient.getTopologyData(groupIds);
    res.json(hosts);
  });

  return router;
}
