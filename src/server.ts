import path from 'path';
import express from 'express';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import pino from 'pino';
import { loadConfig } from './config';
import { createPool } from './db/pool';
import { CustomerRepo } from './services/customerRepo';
import { Mailer } from './services/mailer';
import { AuthService } from './services/authService';
import { ZabbixClient } from './services/zabbixClient';
import { createAuthRouter } from './routes/auth';
import { createNotificationsRouter } from './routes/notifications';
import { createMaintenanceRouter } from './routes/maintenance';
import { createHostsRouter } from './routes/hosts';
import { createTopologyRouter } from './routes/topology';
import { createInquiryRouter } from './routes/inquiry';
import { createCustomerApplicationRouter } from './routes/customerApplication';
import { createAdminCustomerApplicationsRouter } from './routes/adminCustomerApplications';
import { createAdminOpsHistoryRouter } from './routes/adminOpsHistory';
import { createAdminReportSettingsRouter } from './routes/adminReportSettings';
import { createAdminMonthlyReportsRouter } from './routes/adminMonthlyReports';
import { createAdminOnboardingRouter } from './routes/adminOnboarding';
import { createAdminPrincipalsRouter } from './routes/adminPrincipals';
import { createAdminSettingsRouter } from './routes/adminSettings';
import { createPublicSettingsRouter } from './routes/publicSettings';
import { createStaffAuthRouter } from './routes/staffAuth';
import { createStaffSessionRouter } from './routes/staffSession';
import { AdminPrincipalsRepo } from './services/adminPrincipalsRepo';
import { CustomerApplicationRepo } from './services/customerApplicationRepo';
import { isGroupMember } from './services/groupMembershipService';
import { OpsHistoryRepo } from './services/opsHistoryRepo';
import { ReportSettingsRepo } from './services/reportSettingsRepo';
import { MonthlyReportRepo } from './services/monthlyReportRepo';
import { ReportStorage } from './services/reportStorage';
import { SettingsRepo } from './services/settingsRepo';
import { StaffAuthService } from './services/staffAuthService';
import { requireStaffAuth, requireAdminRole } from './middleware/staffAuth';
import { requireMspAdmin, requireSecureGuardIdentity } from './middleware/secureGuardAuth';
import { createIpRateLimiter } from './middleware/rateLimit';
import type { StaffRoleDeps } from './domain/staffRoles';
import { SecureGuardRepo } from './services/secureGuardRepo';
import { SecureGuardIdentityService } from './services/secureGuardIdentityService';
import { DnsFilterInventoryClient } from './services/dnsFilterInventoryClient';
import { createSecureGuardAuthRouter } from './routes/secureGuardAuth';
import { createSecureGuardRouter } from './routes/secureGuard';
import { DnsFilterManagementClient } from './services/dnsFilterManagementClient';
import { safeHttpLogRedactions, safeHttpLogSerializers } from './lib/httpLog';

async function main(): Promise<void> {
  const config = await loadConfig();
  const logger = pino({ level: config.nodeEnv === 'production' ? 'info' : 'debug' });

  const pool = createPool(config);
  const customerRepo = new CustomerRepo(pool);
  const mailer = new Mailer(config.smtp);
  const authService = new AuthService(pool, customerRepo, mailer, config);
  const zabbixClient = new ZabbixClient(config.zabbix);
  const customerApplicationRepo = new CustomerApplicationRepo(pool);
  const opsHistoryRepo = new OpsHistoryRepo(pool);
  const reportSettingsRepo = new ReportSettingsRepo(pool);
  const monthlyReportRepo = new MonthlyReportRepo(pool);
  const reportStorage = new ReportStorage(config.monthlyReport.storageBucket);
  const settingsRepo = new SettingsRepo(pool);
  const secureGuardRepo = new SecureGuardRepo(pool);
  const secureGuardIdentityService = new SecureGuardIdentityService(secureGuardRepo, config.jwtSecret, config.jwtExpiresIn);
  // Deployment supplies this only to the server process. No browser route can read it.
  const dnsFilterInventoryClient = new DnsFilterInventoryClient(process.env.DNSFILTER_API_KEY);
  const dnsFilterManagementClient = new DnsFilterManagementClient(config.gcpProjectId, process.env.DNSFILTER_MSP_ID);
  const staffAuthService = new StaffAuthService(config.staffAuth.jwtSecret);
  const adminPrincipalsRepo = new AdminPrincipalsRepo(pool);
  const staffRoleDeps: StaffRoleDeps = {
    listAdminPrincipals: () => adminPrincipalsRepo.listAdminPrincipals(),
    resolveAndCacheGroupResourceName: (id, groupEmail) =>
      adminPrincipalsRepo.resolveAndCacheGroupResourceName(id, groupEmail),
    isGroupMember,
  };

  const app = express();
  // Cloud Run本番ではGoogle Front Endが1ホップ手前でTLS終端しX-Forwarded-Forを付与するため、
  // req.ipが正しいクライアントIPを指すようにtrust proxyを有効化する（IPレート制限で使用）。
  app.set('trust proxy', true);
  app.use(pinoHttp({ logger, serializers: safeHttpLogSerializers, redact: safeHttpLogRedactions }));
  app.use(express.json());
  app.use(cookieParser());

  app.get('/healthz', (_req, res) => res.status(200).send('ok'));
  // ルート（/）はLPページ(index.html)ではなくログイン画面へリダイレクトする。
  // express.staticのindexファイル解決より前に登録すること。
  app.get('/', (_req, res) => res.redirect('/login.html'));

  app.use('/api/auth', createAuthRouter(authService, customerRepo, config.nodeEnv === 'production'));
  app.use(
    '/api/notifications',
    createNotificationsRouter(authService, customerRepo, zabbixClient, config.zabbix),
  );
  app.use('/api/maintenance', createMaintenanceRouter(authService, customerRepo, zabbixClient));
  app.use('/api/hosts', createHostsRouter(authService, customerRepo, zabbixClient));
  app.use('/api/topology', createTopologyRouter(authService, customerRepo, zabbixClient));
  app.use('/api/inquiry', createInquiryRouter());
  app.use(
    '/api/customer-application',
    createCustomerApplicationRouter(customerApplicationRepo, mailer, settingsRepo, config.portalBaseUrl, {
      notifyEmail: config.customerApplicationNotifyEmail,
      bookingUrl: config.bookingUrl,
      slackWebhookUrl: config.slack.webhookCustomerApplication,
    }),
  );
  app.use('/api/settings', createPublicSettingsRouter(settingsRepo, config.bookingUrl));

  // Secure Guard keeps a separate personal-identity session. Existing customer and staff sessions remain unchanged.
  app.use(
    '/api/secure-guard/auth',
    createSecureGuardAuthRouter(secureGuardIdentityService, config.nodeEnv === 'production'),
  );
  app.use(
    '/api/secure-guard',
    createSecureGuardRouter({
      identityService: secureGuardIdentityService,
      repo: secureGuardRepo,
      inventoryClient: dnsFilterInventoryClient,
      mailer,
      portalBaseUrl: config.portalBaseUrl,
      managementClient: dnsFilterManagementClient,
    }),
  );

  // Google Workspaceログイン（無認証でアクセスできる必要がある）
  app.use(
    '/auth',
    createStaffAuthRouter(staffAuthService, staffRoleDeps, config, config.nodeEnv === 'production'),
  );
  app.use('/api/staff/session', createStaffSessionRouter(staffAuthService));

  // 管理画面（Google Workspace認証保護）。ブルートフォース対策として同じIPレート制限を認証チェックの前段にも適用する。
  // maxRequestsは元30だったが、ページ遷移1回で複数API呼び出しが発生する画面が増え、通常のスタッフ利用でも
  // 上限に達してしまっていたため300に緩和。
  const adminAuthGate = [
    createIpRateLimiter({ windowMs: 15 * 60 * 1000, maxRequests: 300 }),
    requireStaffAuth(staffAuthService),
  ];
  // 設定画面専用。一般ロール（atl_info@）は403になる（管理者=director@のみアクセス可）。
  const adminOnlyGate = [...adminAuthGate, requireAdminRole()];
  app.use('/api/admin/settings', ...adminOnlyGate, createAdminSettingsRouter(settingsRepo, {
    booking_url: config.bookingUrl,
    customer_application_notify_email: config.customerApplicationNotifyEmail,
    slack_webhook_customer_application: config.slack.webhookCustomerApplication ?? '',
  }));
  app.use('/api/admin/admin-principals', ...adminOnlyGate, createAdminPrincipalsRouter(adminPrincipalsRepo));
  app.use(
    '/api/admin/customer-applications',
    ...adminAuthGate,
    createAdminCustomerApplicationsRouter(customerApplicationRepo),
  );
  app.use('/api/admin/ops-history', ...adminAuthGate, createAdminOpsHistoryRouter(opsHistoryRepo, customerRepo));
  app.use(
    '/api/admin/report-settings',
    ...adminAuthGate,
    createAdminReportSettingsRouter(reportSettingsRepo, customerRepo, zabbixClient),
  );
  app.use(
    '/api/admin/monthly-reports',
    ...adminAuthGate,
    createAdminMonthlyReportsRouter(
      monthlyReportRepo,
      customerRepo,
      zabbixClient,
      config.zabbix,
      reportStorage,
      mailer,
      config.monthlyReport.fromEmail,
    ),
  );
  app.use(
    '/api/admin/onboarding',
    ...adminAuthGate,
    createAdminOnboardingRouter(
      {
        customerRepo,
        zabbixClient,
        authService,
        mailer,
        notificationUsrgrpId: config.zabbix.notificationUsrgrpId,
        passwordResetUrlBase: config.passwordResetUrlBase,
      },
      config.cloudRunJob,
    ),
  );
  // 静的HTML側もスタッフ認証で保護する。settings.htmlは管理者専用のためadminOnlyGateを個別に先に登録すること
  // （下の一般admin static配信より後だと、adminAuthGate止まりで一般ロールでも読めてしまう）。
  app.get('/admin/settings.html', ...adminOnlyGate, (_req, res) =>
    res.sendFile(path.join(__dirname, '../public/admin/settings.html')),
  );
  app.use('/admin', ...adminAuthGate, express.static(path.join(__dirname, '../public/admin')));

  app.get('/secure-guard-home.html', requireSecureGuardIdentity(secureGuardIdentityService), (_req, res) =>
    res.sendFile(path.join(__dirname, '../public/secure-guard-home.html')),
  );
  app.get('/secure-guard-admin.html', requireSecureGuardIdentity(secureGuardIdentityService), requireMspAdmin(secureGuardRepo), (_req, res) =>
    res.sendFile(path.join(__dirname, '../public/secure-guard-admin.html')),
  );

  app.use(express.static(path.join(__dirname, '../public')));

  app.listen(config.port, () => {
    logger.info(`msp-customer-portal listening on :${config.port}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err);
  process.exit(1);
});
