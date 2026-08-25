import { getSecret } from './lib/secrets';

export interface Config {
  nodeEnv: string;
  port: number;
  gcpProjectId: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  db: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
    socketPath?: string;
  };
  zabbix: {
    apiUrl: string;
    hostHeader?: string;
    user: string;
    password: string;
    mediaTypeEmailId: string;
    notificationUsrgrpId: string; // オンボーディング時に通知用Zabbixユーザーを所属させるユーザーグループID
    notificationRoleId: string; // Zabbix 7.0のuser.createで必須のroleid（通知専用ユーザーに割り当てるロール）
    templateIcmpId: string; // 「ICMP Ping」テンプレートID
    templateSnmpId: string; // 「Network Generic Device by SNMP」テンプレートID
  };
  smtp: {
    host: string;
    port: number;
    user: string;
    password: string;
    from: string;
  };
  passwordResetUrlBase: string;
  staffAuth: {
    googleClientId: string;
    googleClientSecret: string;
    jwtSecret: string;
  };
  customerApplicationNotifyEmail: string; // 顧客申込みフォーム: 新規申込みの通知先（カンマ区切りで複数可）
  portalBaseUrl: string; // 例: https://portal.atlib.jp（通知メール内の管理画面リンク生成用。passwordResetUrlBaseから導出）
  bookingUrl: string; // ヒアリング日程調整用の予約ページURL（TimeRex等）。顧客申込み確認メール・apply.htmlの完了画面で案内する
  monthlyReport: {
    storageBucket: string; // 月次レポートPPTXの保存先バケット
    staffNotifyEmail: string; // バッチ完了時の「承認待ちがN件あります」通知先（カンマ区切りで複数可）
    fromEmail: string; // 月次レポート関連メール(顧客送付・バッチ完了通知)専用の送信元アドレス
  };
  slack: {
    // Slack Incoming Webhook URL。任意項目(undefinedなら送信をスキップするだけでメール通知には影響しない)。
    // 実際にどのチャンネルに束ねるかはユーザーがSlack側で発行したURLをどのキーに設定するかで決まる
    // (コード側はチャンネルの概念を持たない)。
    webhookCustomerApplication?: string;
    webhookMonthlyReport?: string;
  };
  cloudRunJob: {
    // オンボーディング時のZabbixディスカバリ設定Job（msp-discovery-setup）呼び出し用。
    // discoverySetupJobNameは任意項目(undefinedならadminOnboardingがJob起動をスキップするだけで
    // オンボーディング自体は成功する。Job未デプロイの段階でもポータル本体を先にデプロイできる、
    // 段階的ロールアウトのため)。
    projectId: string;
    region: string;
    discoverySetupJobName?: string;
  };
}

/**
 * 環境変数を優先し、値が無ければ Secret Manager から取得する。
 * Cloud Run本番では `--set-secrets` で環境変数に直接注入されるため通常はSecret Manager呼び出しは発生しない。
 * ハードコードは一切しない（値がどちらの手段でも取得できなければ起動時に例外で落とす）。
 */
async function resolveSecret(
  projectId: string,
  envValue: string | undefined,
  secretId: string,
): Promise<string> {
  if (envValue) return envValue;
  return getSecret(projectId, secretId);
}

export async function loadConfig(): Promise<Config> {
  const gcpProjectId = process.env.GCP_PROJECT_ID ?? 'msp-zabbix';

  const jwtSecret = await resolveSecret(gcpProjectId, process.env.JWT_SECRET, 'portal-jwt-secret');
  const dbPassword = await resolveSecret(gcpProjectId, process.env.DB_PASSWORD, 'portal-db-password');
  const zabbixUser = await resolveSecret(gcpProjectId, process.env.ZABBIX_API_USER, 'portal-zabbix-user');
  const zabbixPassword = await resolveSecret(
    gcpProjectId,
    process.env.ZABBIX_API_PASSWORD,
    'portal-zabbix-password',
  );
  const smtpPassword = await resolveSecret(gcpProjectId, process.env.SMTP_PASSWORD, 'portal-smtp-password');
  const googleOauthClientSecret = await resolveSecret(
    gcpProjectId,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    'portal-google-oauth-client-secret',
  );
  const staffJwtSecret = await resolveSecret(gcpProjectId, process.env.STAFF_JWT_SECRET, 'portal-staff-jwt-secret');

  const required = (name: string, value: string | undefined): string => {
    if (!value) throw new Error(`Missing required config value: ${name}`);
    return value;
  };

  const passwordResetUrlBase = required('PASSWORD_RESET_URL_BASE', process.env.PASSWORD_RESET_URL_BASE);

  return {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: Number(process.env.PORT ?? 8080),
    gcpProjectId,
    jwtSecret,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '24h',
    db: {
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 5432),
      name: required('DB_NAME', process.env.DB_NAME),
      user: required('DB_USER', process.env.DB_USER),
      password: dbPassword,
      socketPath: process.env.DB_SOCKET_PATH || undefined,
    },
    zabbix: {
      apiUrl: required('ZABBIX_API_URL', process.env.ZABBIX_API_URL),
      hostHeader: process.env.ZABBIX_API_HOST_HEADER || undefined,
      user: zabbixUser,
      password: zabbixPassword,
      mediaTypeEmailId: required('ZABBIX_MEDIATYPE_EMAIL', process.env.ZABBIX_MEDIATYPE_EMAIL),
      notificationUsrgrpId: required('ZABBIX_NOTIFICATION_USRGRPID', process.env.ZABBIX_NOTIFICATION_USRGRPID),
      notificationRoleId: required('ZABBIX_NOTIFICATION_ROLEID', process.env.ZABBIX_NOTIFICATION_ROLEID),
      templateIcmpId: required('ZABBIX_TEMPLATE_ICMP', process.env.ZABBIX_TEMPLATE_ICMP),
      templateSnmpId: required('ZABBIX_TEMPLATE_SNMP', process.env.ZABBIX_TEMPLATE_SNMP),
    },
    smtp: {
      host: required('SMTP_HOST', process.env.SMTP_HOST),
      port: Number(process.env.SMTP_PORT ?? 587),
      user: required('SMTP_USER', process.env.SMTP_USER),
      password: smtpPassword,
      from: required('SMTP_FROM', process.env.SMTP_FROM),
    },
    passwordResetUrlBase,
    staffAuth: {
      googleClientId: required('GOOGLE_OAUTH_CLIENT_ID', process.env.GOOGLE_OAUTH_CLIENT_ID),
      googleClientSecret: googleOauthClientSecret,
      jwtSecret: staffJwtSecret,
    },
    customerApplicationNotifyEmail: required(
      'CUSTOMER_APPLICATION_NOTIFY_EMAIL',
      process.env.CUSTOMER_APPLICATION_NOTIFY_EMAIL,
    ),
    bookingUrl: required('BOOKING_URL', process.env.BOOKING_URL),
    // 新規env不要でportalBaseUrlを導出する（passwordResetUrlBaseは既にportalのオリジンを含んでいるため）。
    // 同じ導出パターンをscripts/onboarding/create_customer.tsのloginUrl組み立てでも使っている。
    portalBaseUrl: new URL(passwordResetUrlBase).origin,
    monthlyReport: {
      storageBucket: required('MONTHLY_REPORT_STORAGE_BUCKET', process.env.MONTHLY_REPORT_STORAGE_BUCKET),
      staffNotifyEmail: required('MONTHLY_REPORT_STAFF_EMAIL', process.env.MONTHLY_REPORT_STAFF_EMAIL),
      fromEmail: required('MONTHLY_REPORT_FROM_EMAIL', process.env.MONTHLY_REPORT_FROM_EMAIL),
    },
    slack: {
      webhookCustomerApplication: process.env.SLACK_WEBHOOK_CUSTOMER_APPLICATION || undefined,
      webhookMonthlyReport: process.env.SLACK_WEBHOOK_MONTHLY_REPORT || undefined,
    },
    cloudRunJob: {
      projectId: gcpProjectId,
      region: process.env.DISCOVERY_JOB_REGION ?? 'asia-northeast1',
      discoverySetupJobName: process.env.DISCOVERY_SETUP_JOB_NAME || undefined,
    },
  };
}
