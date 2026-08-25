import { Router } from 'express';
import type { SettingsRepo } from '../services/settingsRepo';

/** 無認証。apply.html完了画面が予約リンクを動的に取得するために使う。 */
export function createPublicSettingsRouter(settingsRepo: SettingsRepo, defaultBookingUrl: string): Router {
  const router = Router();

  router.get('/booking-url', async (_req, res) => {
    const value = await settingsRepo.get('booking_url');
    res.json({ bookingUrl: value ?? defaultBookingUrl });
  });

  return router;
}
