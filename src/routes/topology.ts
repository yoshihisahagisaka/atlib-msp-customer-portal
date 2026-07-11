import { Router } from 'express';
import { z } from 'zod';
import type { AuthService } from '../services/authService';
import type { CustomerRepo } from '../services/customerRepo';
import type { ZabbixClient } from '../services/zabbixClient';
import { requireAuth } from '../middleware/auth';

const roleSchema = z.object({
  role: z.enum(['router', 'switch', 'ap', 'printer', 'other']),
});

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

  router.put('/:hostId/role', async (req, res) => {
    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }

    const groupIds = await customerRepo.resolveHostgroupIds(req.customerId!);
    const owns = await zabbixClient.verifyHostOwnership(req.params.hostId, groupIds);
    if (!owns) {
      res.status(404).json({ error: 'Host not found' });
      return;
    }

    await zabbixClient.setHostRole(req.params.hostId, parsed.data.role);
    res.status(204).end();
  });

  return router;
}
