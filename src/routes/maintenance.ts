import { Router } from 'express';
import { z } from 'zod';
import type { AuthService } from '../services/authService';
import type { CustomerRepo } from '../services/customerRepo';
import type { ZabbixClient } from '../services/zabbixClient';
import { requireAuth } from '../middleware/auth';

const maintenanceTypeSchema = z.enum(['notificationsOnly', 'fullStop']);

const createSchema = z.object({
  name: z.string().min(1),
  activeSince: z.number().int().positive(), // UNIXタイムスタンプ（秒）
  activeTill: z.number().int().positive(),
  maintenanceType: maintenanceTypeSchema,
  allHosts: z.boolean(),
  hostIds: z.array(z.string()).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  activeSince: z.number().int().positive().optional(),
  activeTill: z.number().int().positive().optional(),
  maintenanceType: maintenanceTypeSchema.optional(),
  allHosts: z.boolean().optional(),
  hostIds: z.array(z.string()).optional(),
});

function toZabbixType(t: z.infer<typeof maintenanceTypeSchema>): 0 | 1 {
  return t === 'fullStop' ? 1 : 0;
}

function fromZabbixType(t: string): z.infer<typeof maintenanceTypeSchema> {
  return t === '1' ? 'fullStop' : 'notificationsOnly';
}

export function createMaintenanceRouter(
  authService: AuthService,
  customerRepo: CustomerRepo,
  zabbixClient: ZabbixClient,
): Router {
  const router = Router();
  router.use(requireAuth(authService));

  router.get('/', async (req, res) => {
    const groupIds = await customerRepo.resolveHostgroupIds(req.customerId!);
    const maintenances = await zabbixClient.getMaintenances(groupIds);
    res.json(
      maintenances.map((m) => ({
        id: m.maintenanceid,
        name: m.name,
        activeSince: Number(m.active_since),
        activeTill: Number(m.active_till),
        maintenanceType: fromZabbixType(m.maintenance_type),
        hosts: (m.hosts ?? []).map((h) => ({ id: h.hostid, name: h.host })),
      })),
    );
  });

  router.get('/hosts', async (req, res) => {
    const groupIds = await customerRepo.resolveHostgroupIds(req.customerId!);
    const hosts = await zabbixClient.getHosts(groupIds);
    res.json(hosts.map((h) => ({ id: h.hostid, name: h.name })));
  });

  router.post('/', async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    if (parsed.data.activeTill <= parsed.data.activeSince) {
      res.status(400).json({ error: 'activeTill must be after activeSince' });
      return;
    }

    const groupIds = await customerRepo.resolveHostgroupIds(req.customerId!);
    const id = await zabbixClient.createMaintenance({
      name: parsed.data.name,
      activeSince: parsed.data.activeSince,
      activeTill: parsed.data.activeTill,
      maintenanceType: toZabbixType(parsed.data.maintenanceType),
      groupIds,
      hostIds: parsed.data.allHosts ? undefined : parsed.data.hostIds,
    });
    res.status(201).json({ id });
  });

  router.put('/:id', async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }

    const groupIds = await customerRepo.resolveHostgroupIds(req.customerId!);
    const owns = await zabbixClient.verifyMaintenanceOwnership(req.params.id, groupIds);
    if (!owns) {
      res.status(404).json({ error: 'Maintenance not found' });
      return;
    }

    await zabbixClient.updateMaintenance(req.params.id, {
      name: parsed.data.name,
      activeSince: parsed.data.activeSince,
      activeTill: parsed.data.activeTill,
      maintenanceType: parsed.data.maintenanceType ? toZabbixType(parsed.data.maintenanceType) : undefined,
      hostIds: parsed.data.allHosts === true ? [] : parsed.data.hostIds,
      groupIds,
    });
    res.status(204).end();
  });

  router.delete('/:id', async (req, res) => {
    const groupIds = await customerRepo.resolveHostgroupIds(req.customerId!);
    const owns = await zabbixClient.verifyMaintenanceOwnership(req.params.id, groupIds);
    if (!owns) {
      res.status(404).json({ error: 'Maintenance not found' });
      return;
    }

    await zabbixClient.deleteMaintenance(req.params.id);
    res.status(204).end();
  });

  return router;
}
