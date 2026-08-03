import { Router } from 'express';
import { z } from 'zod';
import { CATEGORIES, QUESTIONS, QUESTION_SET_VERSION, buildAnswersSchema, scoreSubmission } from '../domain/ismsDiagnostic';
import { createIpRateLimiter } from '../middleware/rateLimit';
import type { IsmsDiagnosticRepo } from '../services/ismsDiagnosticRepo';
import type { Mailer } from '../services/mailer';
import { sendSlackNotification } from '../services/slackNotifier';

const leadSchema = z.object({
  companyName: z.string().min(1).max(200),
  contactName: z.string().min(1).max(200),
  email: z.string().email(),
  phone: z.string().max(50).optional(),
});

const submissionSchema = leadSchema.extend({
  answers: buildAnswersSchema(),
});

// 5回/時間/IP。フォーム自体が7〜15問と長く、正規利用者が短時間に何度も送信することは想定しにくいため厳しめに設定。
const submitRateLimiter = createIpRateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 5 });

export function createIsmsDiagnosticRouter(
  repo: IsmsDiagnosticRepo,
  mailer: Mailer,
  notifyEmail: string,
  portalBaseUrl: string,
  slackWebhookUrl: string | undefined,
): Router {
  const router = Router();

  // 配点（score）を除いたクライアント向け質問定義。フォームはこれを元に動的描画するため、
  // 質問を追加・変更してもこのエンドポイント・フロント側のコード変更は不要（domain/ismsDiagnostic.tsのみ編集すればよい）。
  router.get('/questions', (_req, res) => {
    res.json({
      questionSetVersion: QUESTION_SET_VERSION,
      categories: CATEGORIES.map((c) => ({ id: c.id, label: c.label, scored: c.scored })),
      questions: QUESTIONS.map((q) => ({
        id: q.id,
        categoryId: q.categoryId,
        prompt: q.prompt,
        type: q.type,
        required: q.required,
        options: q.options?.map((o) => ({ value: o.value, label: o.label })),
      })),
    });
  });

  router.post('/', submitRateLimiter, async (req, res) => {
    const parsed = submissionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }

    const { companyName, contactName, email, phone, answers: rawAnswers } = parsed.data;
    const answerInputs = Object.entries(rawAnswers)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([questionId, value]) => ({ questionId, value }));

    const scored = scoreSubmission(answerInputs);

    let id: string;
    try {
      id = await repo.insertSubmission({
        companyName,
        contactName,
        email,
        phone,
        questionSetVersion: scored.questionSetVersion,
        answers: scored.answers,
        categoryScores: scored.categoryScores,
        recommendations: scored.recommendations,
        sourceIp: req.ip,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('isms diagnostic submission insert failed:', err);
      res.status(500).json({ error: '送信に失敗しました。しばらくしてから再度お試しください。' });
      return;
    }

    const detailUrl = `${portalBaseUrl}/admin/isms-diagnostic-detail.html?id=${id}`;

    // メール通知はbest-effort。失敗してもDB行・クライアントへのレスポンスには影響させない
    // （リードを失わないことを優先する。失敗時はnotification_email_sent_atがNULLのままadmin一覧に残るのが最終防波堤）。
    try {
      await mailer.sendDiagnosticSubmissionNotification(notifyEmail, {
        id,
        companyName,
        contactName,
        email,
        phone,
        submittedAt: new Date(),
        categoryScores: scored.categoryScores,
        recommendations: scored.recommendations,
        detailUrl,
      });
      await repo.markNotificationSent(id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('isms diagnostic notification email failed:', err);
    }

    // Slack通知はメールとは独立したbest-effortチャンネル。メールが失敗していても送る。
    await sendSlackNotification(
      slackWebhookUrl,
      [
        `*【ISMS診断】新規回答: ${companyName} 様*`,
        `担当者: ${contactName} / メール: ${email}${phone ? ` / 電話番号: ${phone}` : ''}`,
        `詳細を管理画面で確認: ${detailUrl}`,
      ].join('\n'),
    );

    // 顧客にはスコア・推奨プランを一切返さない（受付完了のみ）。atLIBスタッフが確認後フォローする運用のため。
    res.status(204).end();
  });

  return router;
}
