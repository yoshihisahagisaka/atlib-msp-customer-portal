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

const unknownDeviceAlertSchema = z.object({ enabled: z.boolean() });

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

  async function resolveUnknownDeviceAlertState(
    customerCode: string,
    zabbixUserId: string,
  ): Promise<{ available: boolean; enabled: boolean }> {
    const actionId = await zabbixClient.findNewDeviceActionId(customerCode);
    if (!actionId) return { available: false, enabled: false };
    const enabled = await zabbixClient.isUnknownDeviceAlertEnabled(actionId, zabbixUserId);
    return { available: true, enabled };
  }

  router.get('/', async (req, res) => {
    const customer = await customerRepo.findById(req.customerId!);
    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }
    const media = await findEmailMedia(customer.zabbixUserId);
    const unknownDeviceAlert = await resolveUnknownDeviceAlertState(customer.customerCode, customer.zabbixUserId);

    if (!media) {
      res.json({ emails: [], severityPreset: 'warningAndAbove', periodPreset: 'always', unknownDeviceAlert });
      return;
    }

    res.json({
      emails: toEmailList(media.sendto),
      severityPreset: reverseSeverityPreset(media.severity),
      periodPreset: reversePeriodPreset(media.period),
      unknownDeviceAlert,
    });
  });

  router.put('/unknown-device-alert', async (req, res) => {
    const parsed = unknownDeviceAlertSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }

    const customer = await customerRepo.findById(req.customerId!);
    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    const actionId = await zabbixClient.findNewDeviceActionId(customer.customerCode);
    if (!actionId) {
      res.status(404).json({ error: 'Unknown device detection is not available for this account yet' });
      return;
    }

    await zabbixClient.setUnknownDeviceAlertEnabled(actionId, customer.zabbixUserId, parsed.data.enabled);
    res.status(204).end();
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
    // Zabbixはmedia.sendtoを空配列にできないため、最後の1件を削除する場合は
    // media自体をmedias配列から除去する。
    const updated =
      emails.length > 0
        ? medias.map((m) => (m === existing ? { ...m, sendto: emails } : m))
        : medias.filter((m) => m !== existing);

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

function reverseSeverityPreset(severity: number | string): keyof typeof SEVERITY_PRESETS {
  // Zabbix APIはseverityを文字列（例: "48"）で返すため、数値に揃えてから比較する。
  const severityNum = Number(severity);
  const match = (Object.keys(SEVERITY_PRESETS) as Array<keyof typeof SEVERITY_PRESETS>).find(
    (key) => SEVERITY_PRESETS[key] === severityNum,
  );
  return match ?? 'warningAndAbove';
}

function reversePeriodPreset(period: string): keyof typeof PERIOD_PRESETS {
  const match = (Object.keys(PERIOD_PRESETS) as Array<keyof typeof PERIOD_PRESETS>).find(
    (key) => PERIOD_PRESETS[key] === period,
  );
  return match ?? 'always';
}
