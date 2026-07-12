import { Router } from 'express';
import { z } from 'zod';

// お問い合わせフォームの送信先。Sensor Edge機器管理台帳の「問い合わせ管理」タブに
// 記録するため、既存のGoogleフォーム（お問い合わせフォーム）のformResponseエンドポイントへ
// サーバー側からPOSTする。既存のApps Script（form3-inquiry.gs）のonFormSubmitトリガーが
// 通知メール送信・スプレッドシートへの整形コピーを担うため、ここでは中継のみ行う。
//
// entry.XXXXXXの各IDは、フォームの質問文言を変更すると対応しなくなる（サイレントに
// 空欄で送信される）。フォーム側の質問を変更した場合は、フォームの公開HTML
// （FB_PUBLIC_LOAD_DATA_）から新しいIDを確認し、下記を更新すること。
const GOOGLE_FORM_ACTION_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSfKQqVxdLqPNEu2R-pA6GHwVxS92RmrmUHcS3Sr0tNk1mTYQQ/formResponse';

const ENTRY_IDS = {
  company: 'entry.684864970',
  contactName: 'entry.360341380',
  email: 'entry.1862926524',
  subject: 'entry.149223522',
  content: 'entry.770587238',
};

const inquirySchema = z.object({
  company: z.string().min(1).max(200),
  contactName: z.string().min(1).max(200),
  email: z.string().email(),
  subject: z.string().min(1).max(200),
  content: z.string().min(1).max(4000),
});

export function createInquiryRouter(): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const parsed = inquirySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { company, contactName, email, subject, content } = parsed.data;

    const body = new URLSearchParams({
      [ENTRY_IDS.company]: company,
      [ENTRY_IDS.contactName]: contactName,
      [ENTRY_IDS.email]: email,
      [ENTRY_IDS.subject]: subject,
      [ENTRY_IDS.content]: content,
    });

    try {
      const response = await fetch(GOOGLE_FORM_ACTION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      // Googleフォームはブラウザ向けにフォーム画面のHTMLを返すため、成否はステータスコードでのみ判定する
      // （fetchはリダイレクトを自動追跡するため、response.okは送信完了後のconfirmationページの状態を見ている）
      if (!response.ok) {
        // eslint-disable-next-line no-console
        console.error('inquiry form relay failed:', response.status);
        res.status(502).json({ error: 'お問い合わせの送信に失敗しました' });
        return;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('inquiry form relay error:', err);
      res.status(502).json({ error: 'お問い合わせの送信に失敗しました' });
      return;
    }

    res.status(204).end();
  });

  return router;
}
