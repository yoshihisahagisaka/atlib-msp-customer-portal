import { Router } from 'express';
import { z } from 'zod';
import { AiAssistNotConfiguredError, type AiAssistService } from '../services/aiAssistService';

const categorySchema = z.enum(['network', 'server', 'kitting', 'dev', 'other']);
const MAX_REFERENCE_DOC_BYTES = 15 * 1024 * 1024;

const requestSchema = z.object({
  category: categorySchema,
  requirementsText: z.string().min(1).max(20000),
  referenceDocumentBase64: z.string().optional(),
});

/**
 * requireAdminAuthの配下でマウントされる前提（server.ts側で適用）。adminEstimates.tsと同じ構造。
 * server.ts側で、このルートだけ既存のグローバルexpress.json()より前に大きめのlimitで
 * express.json()を個別マウントしている（base64 PDFがデフォルトの100KB上限を超えるため）。
 */
export function createAdminEstimateAiAssistRouter(service: AiAssistService): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }

    if (parsed.data.referenceDocumentBase64) {
      const approxBytes = Math.floor((parsed.data.referenceDocumentBase64.length * 3) / 4);
      if (approxBytes > MAX_REFERENCE_DOC_BYTES) {
        res.status(400).json({ error: '参考資料は15MBまでです' });
        return;
      }
    }

    try {
      const proposal = await service.proposeEstimateAssist(parsed.data);
      res.json(proposal);
    } catch (err) {
      if (err instanceof AiAssistNotConfiguredError) {
        res.status(503).json({ error: 'AI提案機能は現在利用できません' });
        return;
      }
      console.error('AI assist request failed:', err);
      res.status(502).json({ error: 'AI提案の取得に失敗しました。しばらくしてから再度お試しください。' });
    }
  });

  return router;
}
