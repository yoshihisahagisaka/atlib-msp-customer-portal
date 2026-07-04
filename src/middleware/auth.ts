import type { NextFunction, Request, Response } from 'express';
import type { AuthService } from '../services/authService';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      customerId?: string;
    }
  }
}

const COOKIE_NAME = 'portal_session';

/**
 * JWTをHttpOnly CookieからのみFrom検証する。以降のルートハンドラは
 * リクエストボディ・クエリから顧客ID/ホストグループIDを一切読んではならない
 * （必ず req.customerId → customerRepo 経由で解決すること）。
 */
export function requireAuth(authService: AuthService) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    try {
      const payload = authService.verifyToken(token);
      req.customerId = payload.customerId;
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired session' });
    }
  };
}

export function setSessionCookie(res: Response, token: string, isProduction: boolean): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000, // 24時間（設計書どおり。JWT自体のexpiresInと揃えること）
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME);
}
