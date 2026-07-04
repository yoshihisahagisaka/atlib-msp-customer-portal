import { Router } from 'express';
import { z } from 'zod';
import type { AuthService } from '../services/authService';
import type { CustomerRepo } from '../services/customerRepo';
import { requireAuth, setSessionCookie, clearSessionCookie } from '../middleware/auth';
import { checkLoginRateLimit, loginRateLimiter } from '../middleware/rateLimit';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const resetRequestSchema = z.object({
  email: z.string().email(),
});

const resetConfirmSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8),
});

export function createAuthRouter(authService: AuthService, customerRepo: CustomerRepo, isProduction: boolean): Router {
  const router = Router();

  router.post('/login', checkLoginRateLimit, async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { email, password } = parsed.data;

    const token = await authService.login(email, password);
    if (!token) {
      loginRateLimiter.recordFailure(email.toLowerCase());
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    loginRateLimiter.recordSuccess(email.toLowerCase());
    setSessionCookie(res, token, isProduction);
    res.status(204).end();
  });

  router.post('/logout', (_req, res) => {
    clearSessionCookie(res);
    res.status(204).end();
  });

  router.post('/password-reset/request', async (req, res) => {
    const parsed = resetRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    // アカウントの存在有無を漏らさないため、成否によらず常に同じレスポンスを返す
    await authService.requestPasswordReset(parsed.data.email);
    res.status(204).end();
  });

  router.post('/password-reset/confirm', async (req, res) => {
    const parsed = resetConfirmSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const ok = await authService.confirmPasswordReset(parsed.data.token, parsed.data.newPassword);
    if (!ok) {
      res.status(400).json({ error: 'Invalid or expired token' });
      return;
    }
    res.status(204).end();
  });

  router.get('/me', requireAuth(authService), async (req, res) => {
    const customer = await customerRepo.findById(req.customerId!);
    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }
    res.json({ companyName: customer.companyName, email: customer.email });
  });

  return router;
}
