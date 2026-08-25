import { Router } from 'express';
import { z } from 'zod';
import type { AdminPrincipalsRepo } from '../services/adminPrincipalsRepo';

const addSchema = z.object({
  type: z.enum(['email', 'group']),
  value: z.string().min(1).max(320),
});

/**
 * requireStaffAuth + requireAdminRole の配下でマウントされる前提（server.ts側で適用）。
 * 管理者ロールを付与するプリンシパル(個人メール or Googleグループ)の一覧・追加・削除。
 * director@atlib.jp(初期管理者)を最後の1件のまま削除しようとすると、誰も管理者になれなくなるため拒否する
 * (AdminPrincipalsRepo.remove()のガード)。
 */
export function createAdminPrincipalsRouter(repo: AdminPrincipalsRepo): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    const principals = await repo.listAdminPrincipals();
    res.json({ items: principals });
  });

  router.post('/', async (req, res) => {
    const parsed = addSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }

    try {
      const principal = await repo.add(parsed.data.type, parsed.data.value);
      res.status(201).json(principal);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('admin principal add failed:', err);
      const message =
        parsed.data.type === 'group'
          ? `グループ"${parsed.data.value}"が見つかりませんでした。メールアドレスを確認してください。`
          : '登録に失敗しました。';
      res.status(400).json({ error: message });
    }
  });

  router.delete('/:id', async (req, res) => {
    const result = await repo.remove(req.params.id);
    if (result === 'last_principal') {
      res.status(409).json({ error: '最後の管理者プリンシパルは削除できません（誰も管理者になれなくなります）。' });
      return;
    }
    if (result === 'not_found') {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.status(204).end();
  });

  return router;
}
