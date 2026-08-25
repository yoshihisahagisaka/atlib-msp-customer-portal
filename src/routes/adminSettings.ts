import { Router } from 'express';
import { z } from 'zod';
import type { SettingsRepo } from '../services/settingsRepo';
import { SETTINGS_META, validateSettingValue, type SettingKey } from '../domain/portalSettings';

export interface SettingsDefaults {
  booking_url: string;
  customer_application_notify_email: string;
  slack_webhook_customer_application: string;
}

const SETTING_KEYS = SETTINGS_META.map((m) => m.key) as [SettingKey, ...SettingKey[]];
const keySchema = z.enum(SETTING_KEYS);
const putSchema = z.object({ value: z.string().max(2000) });

/**
 * requireStaffAuth + requireAdminRole の配下でマウントされる前提（server.ts側で適用）。
 * 一般ロールは403（middleware/staffAuth.tsのrequireAdminRoleが弾く）。
 */
export function createAdminSettingsRouter(settingsRepo: SettingsRepo, defaults: SettingsDefaults): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const stored = await settingsRepo.getMany(SETTINGS_META.map((m) => m.key));
    const items = SETTINGS_META.map((meta) => ({
      key: meta.key,
      label: meta.label,
      helpText: meta.helpText,
      value: stored[meta.key] ?? defaults[meta.key],
      isDefault: !(meta.key in stored),
    }));
    res.json({ items });
  });

  router.put('/:key', async (req, res) => {
    const keyParsed = keySchema.safeParse(req.params.key);
    if (!keyParsed.success) {
      res.status(404).json({ error: 'Unknown setting key' });
      return;
    }
    const bodyParsed = putSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }

    const key = keyParsed.data;
    const value = bodyParsed.data.value.trim();
    const validationError = validateSettingValue(key, value);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }

    await settingsRepo.set(key, value);
    res.status(204).end();
  });

  return router;
}
