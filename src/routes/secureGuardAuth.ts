import { Router } from 'express';
import { z } from 'zod';
import type { SecureGuardIdentityService } from '../services/secureGuardIdentityService';
import { clearSecureGuardSessionCookie, setSecureGuardSessionCookie } from '../middleware/secureGuardAuth';
import { LoginRateLimiter, checkLoginRateLimitFor, createIpRateLimiter } from '../middleware/rateLimit';

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const invitationAcceptSchema = z.object({ token: z.string().min(1), password: z.string().min(12) });
const challengeSchema = z.object({ challengeToken: z.string().regex(/^[a-f0-9]{64}$/) });
const verifySchema = challengeSchema.extend({ code: z.string().regex(/^[0-9]{6}$/) });
const enrollStartSchema = challengeSchema.extend({ method: z.enum(['totp', 'email']) });

const secureGuardLoginRateLimiter = new LoginRateLimiter();
const secureGuardLoginIpRateLimiter = createIpRateLimiter({ windowMs: 15 * 60 * 1000, maxRequests: 30 });
const secureGuardMfaIpRateLimiter = createIpRateLimiter({ windowMs: 15 * 60 * 1000, maxRequests: 60 });

export function createSecureGuardAuthRouter(identityService: SecureGuardIdentityService, isProduction: boolean): Router {
  const router = Router();

  router.post('/login', secureGuardLoginIpRateLimiter, checkLoginRateLimitFor(secureGuardLoginRateLimiter), async (req, res) => {
    clearSecureGuardSessionCookie(res);
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_REQUEST' });
      return;
    }
    try {
      const flow = await identityService.login(parsed.data.email, parsed.data.password);
      if (!flow) {
        secureGuardLoginRateLimiter.recordFailure(parsed.data.email.toLowerCase());
        res.status(401).json({ error: 'INVALID_CREDENTIALS' });
        return;
      }
      secureGuardLoginRateLimiter.recordSuccess(parsed.data.email.toLowerCase());
      res.status(202).json(flow); // NEVER set the normal Cookie before MFA verification.
    } catch {
      res.status(503).json({ error: 'MFA_UNAVAILABLE' });
    }
  });

  router.post('/invitations/accept', secureGuardLoginIpRateLimiter, async (req, res) => {
    clearSecureGuardSessionCookie(res);
    const parsed = invitationAcceptSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_REQUEST' });
      return;
    }
    try {
      const flow = await identityService.acceptInvitation(parsed.data.token, parsed.data.password);
      if (!flow) {
        res.status(400).json({ error: 'INVITATION_INVALID_OR_EXPIRED' });
        return;
      }
      res.status(202).json(flow); // Existing active Identity may need a fresh password login.
    } catch {
      res.status(503).json({ error: 'MFA_UNAVAILABLE' });
    }
  });

  router.post('/mfa/enroll/start', secureGuardMfaIpRateLimiter, async (req, res) => {
    const parsed = enrollStartSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_REQUEST' });
      return;
    }
    try {
      const result = await identityService.startEnrollment(parsed.data.challengeToken, parsed.data.method);
      if (!result) { res.status(403).json({ error: 'MFA_CHALLENGE_INVALID' }); return; }
      if ('otpauthUrl' in result) res.status(200).json(result);
      else res.status(202).json(result);
    } catch {
      res.status(503).json({ error: 'MFA_UNAVAILABLE' });
    }
  });

  router.post('/mfa/enroll/verify', secureGuardMfaIpRateLimiter, async (req, res) => {
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_REQUEST' });
      return;
    }
    try {
      const verified = await identityService.verifyEnrollment(parsed.data.challengeToken, parsed.data.code);
      if (!verified) { res.status(401).json({ error: 'MFA_CODE_OR_CHALLENGE_INVALID' }); return; }
      setSecureGuardSessionCookie(res, verified.sessionToken, isProduction);
      res.status(200).json({ backupCodes: verified.backupCodes });
    } catch {
      res.status(503).json({ error: 'MFA_UNAVAILABLE' });
    }
  });

  router.post('/mfa/verify', secureGuardMfaIpRateLimiter, async (req, res) => {
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_REQUEST' });
      return;
    }
    try {
      const token = await identityService.verifyMfa(parsed.data.challengeToken, parsed.data.code);
      if (!token) { res.status(401).json({ error: 'MFA_CODE_OR_CHALLENGE_INVALID' }); return; }
      setSecureGuardSessionCookie(res, token, isProduction);
      res.status(204).end();
    } catch {
      res.status(503).json({ error: 'MFA_UNAVAILABLE' });
    }
  });

  router.post('/mfa/email/resend', secureGuardMfaIpRateLimiter, async (req, res) => {
    const parsed = challengeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_REQUEST' });
      return;
    }
    try {
      const result = await identityService.resendEmail(parsed.data.challengeToken);
      if (result === 'rate_limited') {
        res.status(429).json({ error: 'MFA_EMAIL_RATE_LIMITED' }); return;
      }
      if (result !== 'sent') {
        res.status(403).json({ error: 'MFA_CHALLENGE_INVALID' }); return;
      }
      res.status(202).json({ delivery: 'sent' });
    } catch {
      res.status(503).json({ error: 'MFA_UNAVAILABLE' });
    }
  });

  router.post('/logout', (_req, res) => {
    clearSecureGuardSessionCookie(res);
    res.status(204).end();
  });

  return router;
}
