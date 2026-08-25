import jwt from 'jsonwebtoken';
import type { StaffRole } from '../domain/staffRoles';

export interface StaffOauthStatePayload {
  nonce: string; // callbackで受け取るstateクエリと突き合わせるCSRF対策値
  codeVerifier: string; // PKCE
  returnTo: string; // ログイン成功後に戻る画面（/admin/配下の相対パスのみ許容、routes/staffAuth.tsで検証）
}

export interface StaffSessionPayload {
  email: string;
  role: StaffRole;
}

const OAUTH_STATE_EXPIRES_IN = '10m'; // ログインフロー完了までの猶予（顧客用パスワードリセットトークンより短命でよい）
const SESSION_EXPIRES_IN = '24h'; // 顧客用セッション(middleware/auth.ts)と揃える

/**
 * スタッフ（社内Googleアカウント）向けのJWT発行・検証。
 * 顧客用AuthServiceとはDB・bcryptを扱わない点で責務が異なるため別クラスにする。
 * OAuth state用・セッション用のいずれも同じjwtSecretで署名する
 * （自前発行・自前検証のみで外部と鍵を共有しないため1本で十分）。
 */
export class StaffAuthService {
  constructor(private readonly jwtSecret: string) {}

  issueOauthStateToken(payload: StaffOauthStatePayload): string {
    return jwt.sign(payload, this.jwtSecret, { expiresIn: OAUTH_STATE_EXPIRES_IN });
  }

  verifyOauthStateToken(token: string): StaffOauthStatePayload {
    return jwt.verify(token, this.jwtSecret) as StaffOauthStatePayload;
  }

  issueSessionToken(payload: StaffSessionPayload): string {
    return jwt.sign(payload, this.jwtSecret, { expiresIn: SESSION_EXPIRES_IN });
  }

  verifySessionToken(token: string): StaffSessionPayload {
    return jwt.verify(token, this.jwtSecret) as StaffSessionPayload;
  }
}
