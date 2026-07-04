import { Router } from 'express';
import { z } from 'zod';
import type { AuthService } from '../services/authService';
import type { CustomerRepo } from '../services/customerRepo';
import { ZabbixClient, SEVERITY_PRESETS, PERIOD_PRESETS, type ZabbixMedia } from '../services/zabbixClient';
import { requireAuth } from '../middleware/auth';
import type { Config } from '../config';

const addEmailSchema = z.object({ email: z.string().email() });

const settingsSchema = z.object({
  severityPreset: z.enum(['criticalOnly', 'warningAndAbove', 'all']),
  periodPreset: z.enum(['always', 'businessHours']),
});

/** デフォルト設定（設計書の画面仕様どおり: 警告以上・24時間をデフォルトとする） */
const DEFAULT_SEVERITY = SEVERITY_PRESETS.warningAndAbove;
const DEFAULT_PERIOD = PERIOD_PRESETS.always;

export function createNotificationsRouter(
  authService: AuthService,
  customerRepo: CustomerRepo,
  zabbixClient: ZabbixClient,
  zabbixConfig: Config['zabbix'],
): Router {
  const router = Router();
  router.use(requireAuth(authService));

  async function findEmailMedia(zabbixUserId: string): Promise<ZabbixMedia | undefined> {
    const medias = await zabbixClient.getUserMedias(zabbixUserId);
    return medias.find((m) => m.mediatypeid === zabbixConfig.mediaTypeEmailId);
  }

  function toEmailList(sendto: string | string[]): string[] {
    return Array.isArray(sendto) ? sendto : [sendto];
  }

  router.get('/', async (req, res) => {
    const zabbixUserId = await customerRepo.getZabbixUserId(req.customerId!);
    const media = await findEmailMedia(zabbixUserId);

    if (!media) {
      res.json({ emails: [], severityPreset: 'warningAndAbove', periodPreset: 'always' });
      return;
    }

    res.json({
      emails: toEmailList(media.sendto),
      severityPreset: reverseSeverityPreset(media.severity),
      periodPreset: reversePeriodPreset(media.period),
    });
  });

  router.post('/emails', async (req, res) => {
    const parsed = addEmailSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }

    const zabbixUserId = await customerRepo.getZabbixUserId(req.customerId!);
    const medias = await zabbixClient.getUserMedias(zabbixUserId);
    const existing = medias.find((m) => m.mediatypeid === zabbixConfig.mediaTypeEmailId);

    let updated: ZabbixMedia[];
    if (existing) {
      const emails = new Set(toEmailList(existing.sendto));
      emails.add(parsed.data.email);
      updated = medias.map((m) =>
        m === existing ? { ...m, sendto: Array.from(emails) } : m,
      );
    } else {
      const newMedia: ZabbixMedia = {
        mediatypeid: zabbixConfig.mediaTypeEmailId,
        sendto: [parsed.data.email],
        active: '0',
        severity: DEFAULT_SEVERITY,
        period: DEFAULT_PERIOD,
      };
      updated = [...medias, newMedia];
    }

    await zabbixClient.updateUserMedias(zabbixUserId, updated);
    res.status(204).end();
  });

  router.delete('/emails/:email', async (req, res) => {
    const zabbixUserId = await customerRepo.getZabbixUserId(req.customerId!);
    const medias = await zabbixClient.getUserMedias(zabbixUserId);
    const existing = medias.find((m) => m.mediatypeid === zabbixConfig.mediaTypeEmailId);
    if (!existing) {
      res.status(404).json({ error: 'No notification emails configured' });
      return;
    }

    const emails = toEmailList(existing.sendto).filter((e) => e !== req.params.email);
    const updated = medias.map((m) => (m === existing ? { ...m, sendto: emails } : m));

    await zabbixClient.updateUserMedias(zabbixUserId, updated);
    res.status(204).end();
  });

  router.put('/settings', async (req, res) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }

    const zabbixUserId = await customerRepo.getZabbixUserId(req.customerId!);
    const medias = await zabbixClient.getUserMedias(zabbixUserId);
    const existing = medias.find((m) => m.mediatypeid === zabbixConfig.mediaTypeEmailId);
    if (!existing) {
      res.status(404).json({ error: 'No notification emails configured yet' });
      return;
    }

    const updated = medias.map((m) =>
      m === existing
        ? {
            ...m,
            severity: SEVERITY_PRESETS[parsed.data.severityPreset],
            period: PERIOD_PRESETS[parsed.data.periodPreset],
          }
        : m,
    );

    await zabbixClient.updateUserMedias(zabbixUserId, updated);
    res.status(204).end();
  });

  return router;
}

function reverseSeverityPreset(severity: number): keyof typeof SEVERITY_PRESETS {
  const match = (Object.keys(SEVERITY_PRESETS) as Array<keyof typeof SEVERITY_PRESETS>).find(
    (key) => SEVERITY_PRESETS[key] === severity,
  );
  return match ?? 'warningAndAbove';
}

function reversePeriodPreset(period: string): keyof typeof PERIOD_PRESETS {
  const match = (Object.keys(PERIOD_PRESETS) as Array<keyof typeof PERIOD_PRESETS>).find(
    (key) => PERIOD_PRESETS[key] === period,
  );
  return match ?? 'always';
}
