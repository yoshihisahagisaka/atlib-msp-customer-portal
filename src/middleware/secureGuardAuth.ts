import type { NextFunction, Request, Response } from 'express';
import type { CustomerScope } from '../domain/secureGuard';
import type { SecureGuardIdentityService } from '../services/secureGuardIdentityService';
import type { SecureGuardRepo } from '../services/secureGuardRepo';

export const SECURE_GUARD_COOKIE_NAME = 'secure_guard_session';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      secureGuardUserId?: string;
      secureGuardScope?: CustomerScope;
    }
  }
}

export function requireSecureGuardIdentity(identityService: SecureGuardIdentityService) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = req.cookies?.[SECURE_GUARD_COOKIE_NAME];
    if (!token) {
      res.status(401).json({ error: 'AUTH_REQUIRED' });
      return;
    }
    try {
      const payload = identityService.verifySession(token);
      const user = await identityService.verifyActiveSession(payload);
      if (!user) {
        res.status(403).json({ error: 'IDENTITY_INACTIVE' });
        return;
      }
      req.secureGuardUserId = user.id;
      next();
    } catch {
      res.status(401).json({ error: 'AUTH_REQUIRED' });
    }
  };
}

export function requireSecureGuardCustomerScope(repo: SecureGuardRepo) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const membershipId = req.header('X-Secure-Guard-Membership');
    if (!req.secureGuardUserId || !membershipId) {
      res.status(403).json({ error: 'CUSTOMER_SCOPE_DENIED' });
      return;
    }
    const scope = await repo.findActiveScope(req.secureGuardUserId, membershipId);
    if (!scope) {
      res.status(403).json({ error: 'CUSTOMER_SCOPE_DENIED' });
      return;
    }
    req.secureGuardScope = scope;
    next();
  };
}

export function requireMspAdmin(repo: SecureGuardRepo) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.secureGuardUserId || !(await repo.hasActiveMspAdminGrant(req.secureGuardUserId))) {
      res.status(403).json({ error: 'MSP_SCOPE_DENIED' });
      return;
    }
    next();
  };
}

export function setSecureGuardSessionCookie(res: Response, token: string, isProduction: boolean): void {
  res.cookie(SECURE_GUARD_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,
  });
}

export function clearSecureGuardSessionCookie(res: Response): void {
  res.clearCookie(SECURE_GUARD_COOKIE_NAME);
}
