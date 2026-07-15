import { timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

export interface AdminCredentials {
  user: string;
  password: string;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqualは長さが異なると例外を投げるため、事前にチェックする
  // （長さ不一致自体は秘密情報ではないため、ここでの早期returnはタイミング攻撃の材料にならない）。
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * atLIBスタッフ向け管理画面用の共有パスワードBasic Auth。
 * このアプリには顧客用JWT認証（requireAuth）しかなく、スタッフ用アカウントの仕組みが
 * 存在しないため、MVPとして最小構成のBasic Authを採用した（アプリ全体の「自前最小実装」の
 * 方針に合わせている）。監査ログ（誰がアクセスしたか）は取れないため、将来スタッフが増える場合は
 * 個別アカウント制への移行を検討すること。
 */
export function requireAdminAuth(credentials: AdminCredentials) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    if (header?.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
      const separatorIndex = decoded.indexOf(':');
      if (separatorIndex !== -1) {
        const user = decoded.slice(0, separatorIndex);
        const password = decoded.slice(separatorIndex + 1);
        if (safeEqual(user, credentials.user) && safeEqual(password, credentials.password)) {
          next();
          return;
        }
      }
    }
    res.set('WWW-Authenticate', 'Basic realm="atLIB Admin"');
    res.status(401).json({ error: 'Authentication required' });
  };
}
