import { Router } from 'express';
import { z } from 'zod';
import { createIpRateLimiter } from '../middleware/rateLimit';
import type { CustomerApplicationRepo } from '../services/customerApplicationRepo';
import type { Mailer } from '../services/mailer';

const applicationSchema = z.object({
  companyName: z.string().min(1).max(200),
  contactName: z.string().min(1).max(200),
  email: z.string().email(),
  phone: z.string().max(50).optional(),
  interestedPlan: z.string().max(100).optional(),
  message: z.string().max(2000).optional(),
});

// 5回/時間/IP。ismsDiagnostic.tsと同じ厳しめの設定（正規利用者が短時間に何度も送信することは想定しにくい）。
const submitRateLimiter = createIpRateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 5 });

export function createCustomerApplicationRouter(
  repo: CustomerApplicationRepo,
  mailer: Mailer,
  notifyEmail: string,
  portalBaseUrl: string,
): Router {
  const router = Router();

  router.post('/', submitRateLimiter, async (req, res) => {
    const parsed = applicationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }

    const { companyName, contactName, email, phone, interestedPlan, message } = parsed.data;

    let id: string;
    try {
      id = await repo.insertApplication({
        companyName,
        contactName,
        email,
        phone,
        interestedPlan,
        message,
        sourceIp: req.ip,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('customer application insert failed:', err);
      res.status(500).json({ error: '送信に失敗しました。しばらくしてから再度お試しください。' });
      return;
    }

    // メール通知はbest-effort。失敗してもDB行・クライアントへのレスポンスには影響させない
    // （申込みを失わないことを優先する。失敗時はnotification_email_sent_atがNULLのままadmin一覧に残るのが最終防波堤）。
    try {
      await mailer.sendCustomerApplicationNotification(notifyEmail, {
        id,
        companyName,
        contactName,
        email,
        phone,
        interestedPlan,
        message,
        submittedAt: new Date(),
        detailUrl: `${portalBaseUrl}/admin/customer-applications-detail.html?id=${id}`,
      });
      await repo.markNotificationSent(id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('customer application notification email failed:', err);
    }

    res.status(204).end();
  });

  return router;
}
