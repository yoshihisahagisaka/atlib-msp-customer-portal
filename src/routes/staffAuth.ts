import crypto from 'crypto';
import type { Request } from 'express';
import { Router } from 'express';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import type { Config } from '../config';
import { resolveStaffRole, type StaffRoleDeps } from '../domain/staffRoles';
import type { StaffAuthService } from '../services/staffAuthService';
import { clearStaffSessionCookie, setStaffSessionCookie } from '../middleware/staffAuth';

const STATE_COOKIE_NAME = 'staff_oauth_state';
const DEFAULT_RETURN_TO = '/admin/customer-applications.html';
const ALLOWED_HOSTED_DOMAIN = 'atlib.jp';

/**
 * Google Workspaceアカウントによる社内スタッフ用ログイン（Authorization Code + PKCE）。
 * ppap-file-transferのSSO検証スパイクと同じ認可方式だが、Google単体・社内2ロールのみのため
 * jose+HMAC Cookieの自前OIDCクライアントは移植せず、既存依存のgoogle-auth-library(OAuth2Client)と
 * 顧客用と同じJWT+HttpOnly Cookieパターン(StaffAuthService)を使う。
 *
 * ログインできるのはatlib.jpドメインのGoogle Workspaceアカウントのみ(hdクレームで検証)。
 * この制限はmsp-zabbixプロジェクトのOAuth同意画面(GoogleAuth Platform)ではなくアプリ側で行う。
 * 同意画面はプロジェクト全体で共有される1つの設定のため「内部限定」にすると、同じプロジェクトを
 * 使うppap-file-transferのsso-verify-service(外部アカウントでのSSO検証が必須)まで巻き添えで
 * 制限してしまう事故が2026-08-25に発覚したため、同意画面は「外部公開」のまま維持する。
 */
export function createStaffAuthRouter(
  staffAuthService: StaffAuthService,
  staffRoleDeps: StaffRoleDeps,
  config: Pick<Config, 'staffAuth'>,
  isProduction: boolean,
): Router {
  const router = Router();
  const { googleClientId, googleClientSecret } = config.staffAuth;

  // portal.atlib.jp(カスタムドメイン)と*.run.app(デフォルトURL)の両方からアクセスされうるため、
  // redirect_uriは固定値ではなくリクエストごとのHostから動的に組み立てる。固定値だと、例えば
  // portal.atlib.jpで/auth/loginを開始してもコールバックは常に固定ドメイン(例: *.run.app)に
  // 戻ってしまい、state Cookieが別ドメインに置かれたことになって検証できなくなる
  // (2026-08-25、実機検証で発覚)。このためGoogle Cloud Console側でも両方のドメインの
  // /auth/callbackを承認済みリダイレクトURIとして登録しておく必要がある。
  const resolveRedirectUri = (req: Request): string => `${req.protocol}://${req.get('host')}/auth/callback`;

  const createOAuthClient = (redirectUri: string): OAuth2Client =>
    new OAuth2Client({ clientId: googleClientId, clientSecret: googleClientSecret, redirectUri });

  router.get('/login', async (req, res) => {
    const returnToParam = req.query.returnTo;
    // オープンリダイレクト対策: サイト内の絶対パス（'/'始まり、'//'は除く=プロトコル相対URL対策）のみ許容
    const returnTo =
      typeof returnToParam === 'string' && returnToParam.startsWith('/') && !returnToParam.startsWith('//')
        ? returnToParam
        : DEFAULT_RETURN_TO;

    const oauth2Client = createOAuthClient(resolveRedirectUri(req));
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

    const oauth2Client = createOAuthClient(resolveRedirectUri(req));
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
    let hostedDomain: string | undefined;
    try {
      const ticket = await oauth2Client.verifyIdToken({ idToken, audience: googleClientId });
      const payload = ticket.getPayload();
      if (payload?.email && payload.email_verified) {
        email = payload.email;
        hostedDomain = payload.hd;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('staff id_token verification failed:', err);
    }
    if (!email) {
      res.status(400).send(errorPage('Googleログインに失敗しました。もう一度お試しください。'));
      return;
    }
    // hd: 'atlib.jp'以外(未Workspace管理の個人アカウント、他ドメイン等)は拒否。
    // OAuth同意画面のUser Typeを「外部」にしているため(sso-verify-service事情)、Google側では絞られない。
    if (hostedDomain !== ALLOWED_HOSTED_DOMAIN) {
      res.status(403).send(errorPage(`このアカウント（${escapeHtml(email)}）はatlib.jpのGoogle Workspaceアカウントではないため、管理画面へアクセスできません。`));
      return;
    }

    const role = await resolveStaffRole(email, staffRoleDeps);

    const sessionToken = staffAuthService.issueSessionToken({ email, role });
    setStaffSessionCookie(res, sessionToken, isProduction);
    res.redirect(statePayload.returnTo || DEFAULT_RETURN_TO);
  });

  router.get('/logout', (_req, res) => {
    clearStaffSessionCookie(res);
    res.redirect(DEFAULT_RETURN_TO);
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
