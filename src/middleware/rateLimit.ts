import type { NextFunction, Request, Response } from 'express';

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15分（設計書どおり）

interface AttemptRecord {
  failCount: number;
  lockedUntil: number | null;
}

/**
 * ログインエンドポイント用のインメモリ・レート制限（5回失敗で15分ロック）。
 *
 * 注意: インメモリ実装のため、Cloud Runが複数インスタンスにスケールした場合は
 * インスタンスごとに独立してカウントされる（数社規模の低トラフィックを前提とした
 * 割り切り）。将来的に顧客数が増えて複数インスタンス常時稼働になった場合は、
 * Cloud SQL上のテーブルかRedis等の共有ストアに置き換えることを検討する。
 */
export class LoginRateLimiter {
  private readonly attempts = new Map<string, AttemptRecord>();

  isLocked(key: string): boolean {
    const record = this.attempts.get(key);
    if (!record?.lockedUntil) return false;
    if (Date.now() >= record.lockedUntil) {
      this.attempts.delete(key);
      return false;
    }
    return true;
  }

  recordFailure(key: string): void {
    const record = this.attempts.get(key) ?? { failCount: 0, lockedUntil: null };
    record.failCount += 1;
    if (record.failCount >= MAX_ATTEMPTS) {
      record.lockedUntil = Date.now() + LOCKOUT_MS;
    }
    this.attempts.set(key, record);
  }

  recordSuccess(key: string): void {
    this.attempts.delete(key);
  }
}

export const loginRateLimiter = new LoginRateLimiter();

export function checkLoginRateLimit(req: Request, res: Response, next: NextFunction): void {
  checkLoginRateLimitFor(loginRateLimiter)(req, res, next);
}

export function checkLoginRateLimitFor(limiter: LoginRateLimiter): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const email = String(req.body?.email ?? '').toLowerCase();
    if (email && limiter.isLocked(email)) {
      res.status(429).json({ error: 'Too many failed login attempts. Try again later.' });
      return;
    }
    next();
  };
}

/**
 * IPアドレスキーの固定ウィンドウ・レート制限ミドルウェアを生成する汎用ファクトリ。
 * LoginRateLimiterと同じインメモリMap方式のため、Cloud Runが複数インスタンスに
 * スケールした場合はインスタンスごとに独立してカウントされる（同じ割り切り）。
 * req.ip の値が正しくクライアントIPを指すには、Cloud Run環境で app.set('trust proxy', true)
 * が設定されている必要がある（server.tsで設定済み）。
 */
export function createIpRateLimiter(opts: {
  windowMs: number;
  maxRequests: number;
}): (req: Request, res: Response, next: NextFunction) => void {
  const hits = new Map<string, { count: number; windowStart: number }>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const record = hits.get(key);

    if (!record || now - record.windowStart >= opts.windowMs) {
      hits.set(key, { count: 1, windowStart: now });
      next();
      return;
    }

    if (record.count >= opts.maxRequests) {
      res.status(429).json({ error: 'Too many requests. Try again later.' });
      return;
    }

    record.count += 1;
    next();
  };
}
