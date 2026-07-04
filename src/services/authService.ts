import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import type { Pool } from 'pg';
import type { Config } from '../config';
import type { CustomerRepo } from './customerRepo';
import type { Mailer } from './mailer';

const BCRYPT_ROUNDS = 12;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1時間（設計書どおり）

export interface JwtPayload {
  customerId: string;
}

export class AuthService {
  constructor(
    private readonly pool: Pool,
    private readonly customerRepo: CustomerRepo,
    private readonly mailer: Mailer,
    private readonly config: Pick<Config, 'jwtSecret' | 'jwtExpiresIn' | 'passwordResetUrlBase'>,
  ) {}

  /** email/password検証。成功時はJWTを返す。失敗時はnullを返す（呼び出し側でレート制限を行う）。 */
  async login(email: string, password: string): Promise<string | null> {
    const customer = await this.customerRepo.findByEmail(email);
    if (!customer) return null;

    const ok = await bcrypt.compare(password, customer.passwordHash);
    if (!ok) return null;

    const payload: JwtPayload = { customerId: customer.id };
    // jwtExpiresIn は環境変数由来の一般的な string のため、jsonwebtokenの厳密な
    // StringValue型（"24h"等の特定フォーマットのみ許容）とは合致しないのでキャストする。
    const options: jwt.SignOptions = { expiresIn: this.config.jwtExpiresIn as jwt.SignOptions['expiresIn'] };
    return jwt.sign(payload, this.config.jwtSecret, options);
  }

  verifyToken(token: string): JwtPayload {
    return jwt.verify(token, this.config.jwtSecret) as JwtPayload;
  }

  /**
   * パスワードリセットをリクエストする。
   * アカウントの存在有無を外部に漏らさないため、該当メールが無くても常に正常終了する。
   */
  async requestPasswordReset(email: string): Promise<void> {
    const customer = await this.customerRepo.findByEmail(email);
    if (!customer) return; // アカウント有無を漏らさない

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

    await this.pool.query(
      'INSERT INTO password_reset_tokens (customer_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [customer.id, tokenHash, expiresAt],
    );

    const resetUrl = `${this.config.passwordResetUrlBase}?token=${rawToken}`;
    await this.mailer.sendPasswordResetEmail(customer.email, resetUrl);
  }

  /** リセットトークンを検証し、新しいパスワードを設定する。成功/失敗をbooleanで返す。 */
  async confirmPasswordReset(rawToken: string, newPassword: string): Promise<boolean> {
    const tokenHash = this.hashToken(rawToken);

    const { rows } = await this.pool.query<{ id: string; customer_id: string }>(
      `SELECT id, customer_id FROM password_reset_tokens
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
      [tokenHash],
    );
    const record = rows[0];
    if (!record) return false;

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE customers SET password_hash = $1, updated_at = now() WHERE id = $2', [
        passwordHash,
        record.customer_id,
      ]);
      await client.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [record.id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return true;
  }

  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, BCRYPT_ROUNDS);
  }

  private hashToken(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
  }
}
