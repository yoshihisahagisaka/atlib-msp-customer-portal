import { Router } from 'express';
import { z } from 'zod';
import { createIpRateLimiter } from '../middleware/rateLimit';
import type { CustomerApplicationRepo } from '../services/customerApplicationRepo';
import type { Mailer } from '../services/mailer';
import { sendSlackNotification } from '../services/slackNotifier';

const applicationSchema = z.object({
  companyName: z.string().min(1).max(200),
  contactName: z.string().min(1).max(200),
  email: z.string().email(),
  phone: z.string().max(50).optional(),
  interestedPlan: z.string().max(100).optional(),
  message: z.string().max(2000).optional(),
});

// 5回/時間/IP。フォーム自体が長く、正規利用者が短時間に何度も送信することは想定しにくいため厳しめに設定。
const submitRateLimiter = createIpRateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 5 });

export function createCustomerApplicationRouter(
  repo: CustomerApplicationRepo,
  mailer: Mailer,
  notifyEmail: string,
  portalBaseUrl: string,
  slackWebhookUrl: string | undefined,
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

    const detailUrl = `${portalBaseUrl}/admin/customer-applications-detail.html?id=${id}`;

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
        detailUrl,
      });
      await repo.markNotificationSent(id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('customer application notification email failed:', err);
    }

    // Slack通知はメールとは独立したbest-effortチャンネル。メールが失敗していても送る。
    await sendSlackNotification(
      slackWebhookUrl,
      [
        `*【新規申込み】${companyName} 様*`,
        `担当者: ${contactName} / メール: ${email}${phone ? ` / 電話番号: ${phone}` : ''}`,
        interestedPlan ? `興味のあるプラン: ${interestedPlan}` : null,
        `詳細を管理画面で確認: ${detailUrl}`,
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
    );

    res.status(204).end();
  });

  return router;
}
