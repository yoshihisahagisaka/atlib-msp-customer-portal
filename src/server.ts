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
import { createIsmsDiagnosticRouter } from './routes/ismsDiagnostic';
import { createAdminIsmsDiagnosticRouter } from './routes/adminIsmsDiagnostic';
import { createAdminOpsHistoryRouter } from './routes/adminOpsHistory';
import { createAdminReportSettingsRouter } from './routes/adminReportSettings';
import { createAdminMonthlyReportsRouter } from './routes/adminMonthlyReports';
import { IsmsDiagnosticRepo } from './services/ismsDiagnosticRepo';
import { OpsHistoryRepo } from './services/opsHistoryRepo';
import { ReportSettingsRepo } from './services/reportSettingsRepo';
import { MonthlyReportRepo } from './services/monthlyReportRepo';
import { ReportStorage } from './services/reportStorage';
import { requireAdminAuth } from './middleware/adminAuth';
import { createIpRateLimiter } from './middleware/rateLimit';

async function main(): Promise<void> {
  const config = await loadConfig();
  const logger = pino({ level: config.nodeEnv === 'production' ? 'info' : 'debug' });

  const pool = createPool(config);
  const customerRepo = new CustomerRepo(pool);
  const mailer = new Mailer(config.smtp);
  const authService = new AuthService(pool, customerRepo, mailer, config);
  const zabbixClient = new ZabbixClient(config.zabbix);
  const ismsDiagnosticRepo = new IsmsDiagnosticRepo(pool);
  const opsHistoryRepo = new OpsHistoryRepo(pool);
  const reportSettingsRepo = new ReportSettingsRepo(pool);
  const monthlyReportRepo = new MonthlyReportRepo(pool);
  const reportStorage = new ReportStorage(config.monthlyReport.storageBucket);

  const app = express();
  // Cloud Run本番ではGoogle Front Endが1ホップ手前でTLS終端しX-Forwarded-Forを付与するため、
  // req.ipが正しいクライアントIPを指すようにtrust proxyを有効化する（IPレート制限で使用）。
  app.set('trust proxy', true);
  app.use(pinoHttp({ logger })); // 操作ログ（誰がいつ何をしたか）の基礎になる構造化アクセスログ
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
    '/api/isms-diagnostic',
    createIsmsDiagnosticRouter(ismsDiagnosticRepo, mailer, config.diagnosticNotifyEmail, config.portalBaseUrl),
  );

  // 管理画面（Basic Auth保護）。ブルートフォース対策として同じIPレート制限を認証チェックの前段にも適用する。
  const adminAuthGate = [
    createIpRateLimiter({ windowMs: 15 * 60 * 1000, maxRequests: 30 }),
    requireAdminAuth(config.adminAuth),
  ];
  app.use('/api/admin/isms-diagnostic', ...adminAuthGate, createAdminIsmsDiagnosticRouter(ismsDiagnosticRepo));
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
  // 静的HTML側もBasic Authで保護する。この行は下の一般static配信より前に置くこと
  // （逆順だと未認証で/admin/*.htmlが一般static経由で読めてしまう）。
  app.use('/admin', ...adminAuthGate, express.static(path.join(__dirname, '../public/admin')));

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
