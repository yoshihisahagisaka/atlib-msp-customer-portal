import { Router } from 'express';
import type { StaffAuthService } from '../services/staffAuthService';

const COOKIE_NAME = 'staff_session';

/** 管理画面共通ナビ(adminNav.js)がログイン状態・ロール表示・未ログイン時リダイレクトに使う。無認証で叩ける。 */
export function createStaffSessionRouter(staffAuthService: StaffAuthService): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) {
      res.json({ authenticated: false });
      return;
    }
    try {
      const payload = staffAuthService.verifySessionToken(token);
      res.json({ authenticated: true, email: payload.email, role: payload.role });
    } catch {
      res.json({ authenticated: false });
    }
  });

  return router;
}
