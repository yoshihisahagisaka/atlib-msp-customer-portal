import { Router } from 'express';
import { z } from 'zod';
import type { SecureGuardIdentityService } from '../services/secureGuardIdentityService';
import { clearSecureGuardSessionCookie, setSecureGuardSessionCookie } from '../middleware/secureGuardAuth';

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const invitationAcceptSchema = z.object({ token: z.string().min(1), password: z.string().min(12) });

export function createSecureGuardAuthRouter(identityService: SecureGuardIdentityService, isProduction: boolean): Router {
  const router = Router();

  router.post('/login', async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_REQUEST' });
      return;
    }
    const token = await identityService.login(parsed.data.email, parsed.data.password);
    if (!token) {
      res.status(401).json({ error: 'INVALID_CREDENTIALS' });
      return;
    }
    setSecureGuardSessionCookie(res, token, isProduction);
    res.status(204).end();
  });

  router.post('/invitations/accept', async (req, res) => {
    const parsed = invitationAcceptSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_REQUEST' });
      return;
    }
    const token = await identityService.acceptInvitation(parsed.data.token, parsed.data.password);
    if (!token) {
      res.status(400).json({ error: 'INVITATION_INVALID_OR_EXPIRED' });
      return;
    }
    setSecureGuardSessionCookie(res, token, isProduction);
    res.status(204).end();
  });

  router.post('/logout', (_req, res) => {
    clearSecureGuardSessionCookie(res);
    res.status(204).end();
  });

  return router;
}
