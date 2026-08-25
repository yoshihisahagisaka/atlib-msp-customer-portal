import type { NextFunction, Request, Response } from 'express';
import type { StaffAuthService } from '../services/staffAuthService';
import type { StaffRole } from '../domain/staffRoles';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      staffEmail?: string;
      staffRole?: StaffRole;
    }
  }
}

const COOKIE_NAME = 'staff_session';

/**
 * JWTをHttpOnly CookieからのみFrom検証する（middleware/auth.tsの顧客用requireAuthと対の構成）。
 * /api/*配下は未認証時401 JSON、/admin/*.html配下は/auth/loginへの302（元URLをreturnToで保持）。
 * 同じgateを両方の配下に使い回すため（server.ts参照）、パス種別はoriginalUrlのプレフィックスで判定する。
 */
export function requireStaffAuth(staffAuthService: StaffAuthService) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) {
      denyOrRedirect(req, res);
      return;
    }

    try {
      const payload = staffAuthService.verifySessionToken(token);
      req.staffEmail = payload.email;
      req.staffRole = payload.role;
      next();
    } catch {
      denyOrRedirect(req, res);
    }
  };
}

/** requireStaffAuthの後段でのみ使う（req.staffRoleが未設定の状態で使うと常に403になる）。 */
export function requireAdminRole() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.staffRole !== 'admin') {
      res.status(403).json({ error: 'この画面には管理者権限が必要です' });
      return;
    }
    next();
  };
}

function denyOrRedirect(req: Request, res: Response): void {
  if (req.originalUrl.startsWith('/api/')) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  res.redirect(`/auth/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
}

export function setStaffSessionCookie(res: Response, token: string, isProduction: boolean): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000, // 24時間（StaffAuthServiceのセッションJWT expiresInと揃えること）
  });
}

export function clearStaffSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME);
}
