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

  const required = (name: string, value: string | undefined): string => {
    if (!value) throw new Error(`Missing required config value: ${name}`);
    return value;
  };

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
    passwordResetUrlBase: required('PASSWORD_RESET_URL_BASE', process.env.PASSWORD_RESET_URL_BASE),
  };
}
