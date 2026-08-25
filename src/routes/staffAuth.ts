import crypto from 'crypto';
import { Router } from 'express';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import type { Config } from '../config';
import { resolveStaffRole } from '../domain/staffRoles';
import type { StaffAuthService } from '../services/staffAuthService';
import { clearStaffSessionCookie, setStaffSessionCookie } from '../middleware/staffAuth';

const STATE_COOKIE_NAME = 'staff_oauth_state';
const DEFAULT_RETURN_TO = '/admin/';

/**
 * Google Workspaceアカウントによる社内スタッフ用ログイン（Authorization Code + PKCE）。
 * ppap-file-transferのSSO検証スパイクと同じ認可方式だが、Google単体・社内2ロールのみのため
 * jose+HMAC Cookieの自前OIDCクライアントは移植せず、既存依存のgoogle-auth-library(OAuth2Client)と
 * 顧客用と同じJWT+HttpOnly Cookieパターン(StaffAuthService)を使う。
 */
export function createStaffAuthRouter(
  staffAuthService: StaffAuthService,
  config: Pick<Config, 'staffAuth'>,
  isProduction: boolean,
): Router {
  const router = Router();
  const { googleClientId, googleClientSecret, redirectUri, adminEmails, generalEmails } = config.staffAuth;

  const createOAuthClient = (): OAuth2Client =>
    new OAuth2Client({ clientId: googleClientId, clientSecret: googleClientSecret, redirectUri });

  router.get('/login', async (req, res) => {
    const returnToParam = req.query.returnTo;
    // オープンリダイレクト対策: サイト内の絶対パス（'/'始まり、'//'は除く=プロトコル相対URL対策）のみ許容
    const returnTo =
      typeof returnToParam === 'string' && returnToParam.startsWith('/') && !returnToParam.startsWith('//')
        ? returnToParam
        : DEFAULT_RETURN_TO;

    const oauth2Client = createOAuthClient();
    const nonce = crypto.randomBytes(16).toString('hex');
    const { codeVerifier, codeChallenge } = await oauth2Client.generateCodeVerifierAsync();

    const stateToken = staffAuthService.issueOauthStateToken({ nonce, codeVerifier, returnTo });
    res.cookie(STATE_COOKIE_NAME, stateToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000,
    });

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'online',
      scope: ['openid', 'email', 'profile'],
      state: nonce,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
      hd: 'atlib.jp', // Workspaceドメイン候補を絞るUIヒント。認可の必須チェックにはしない（emailはserver側で別途照合する）
    });
    res.redirect(authUrl);
  });

  router.get('/callback', async (req, res) => {
    const stateCookie = req.cookies?.[STATE_COOKIE_NAME];
    const code = req.query.code;
    const state = req.query.state;
    res.clearCookie(STATE_COOKIE_NAME);

    if (!stateCookie || typeof code !== 'string' || typeof state !== 'string') {
      res.status(400).send(errorPage('ログイン処理が正しく開始されませんでした。もう一度お試しください。'));
      return;
    }

    let statePayload;
    try {
      statePayload = staffAuthService.verifyOauthStateToken(stateCookie);
    } catch {
      res.status(400).send(errorPage('ログインセッションの有効期限が切れました。もう一度お試しください。'));
      return;
    }
    if (statePayload.nonce !== state) {
      res.status(400).send(errorPage('ログイン処理が正しく開始されませんでした。もう一度お試しください。'));
      return;
    }

    const oauth2Client = createOAuthClient();
    let idToken: string | null | undefined;
    try {
      const { tokens } = await oauth2Client.getToken({ code, codeVerifier: statePayload.codeVerifier });
      idToken = tokens.id_token;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('staff oauth token exchange failed:', err);
      res.status(400).send(errorPage('Googleログインに失敗しました。もう一度お試しください。'));
      return;
    }
    if (!idToken) {
      res.status(400).send(errorPage('Googleログインに失敗しました。もう一度お試しください。'));
      return;
    }

    let email: string | undefined;
    try {
      const ticket = await oauth2Client.verifyIdToken({ idToken, audience: googleClientId });
      const payload = ticket.getPayload();
      if (payload?.email && payload.email_verified) {
        email = payload.email;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('staff id_token verification failed:', err);
    }
    if (!email) {
      res.status(400).send(errorPage('Googleログインに失敗しました。もう一度お試しください。'));
      return;
    }

    const role = resolveStaffRole(email, adminEmails, generalEmails);
    if (!role) {
      res.status(403).send(errorPage(`このアカウント（${escapeHtml(email)}）には管理画面へのアクセス権限がありません。`));
      return;
    }

    const sessionToken = staffAuthService.issueSessionToken({ email, role });
    setStaffSessionCookie(res, sessionToken, isProduction);
    res.redirect(statePayload.returnTo || DEFAULT_RETURN_TO);
  });

  router.get('/logout', (_req, res) => {
    clearStaffSessionCookie(res);
    res.redirect('/admin/');
  });

  return router;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>ログインエラー</title></head>
<body style="font-family: sans-serif; padding: 2em;">
<p>${message}</p>
<p><a href="/auth/login">ログイン画面に戻る</a></p>
</body></html>`;
}
