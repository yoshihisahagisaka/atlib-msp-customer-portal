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

async function main(): Promise<void> {
  const config = await loadConfig();
  const logger = pino({ level: config.nodeEnv === 'production' ? 'info' : 'debug' });

  const pool = createPool(config);
  const customerRepo = new CustomerRepo(pool);
  const mailer = new Mailer(config.smtp);
  const authService = new AuthService(pool, customerRepo, mailer, config);
  const zabbixClient = new ZabbixClient(config.zabbix);

  const app = express();
  app.use(pinoHttp({ logger })); // 操作ログ（誰がいつ何をしたか）の基礎になる構造化アクセスログ
  app.use(express.json());
  app.use(cookieParser());

  app.get('/healthz', (_req, res) => res.status(200).send('ok'));

  app.use('/api/auth', createAuthRouter(authService, customerRepo, config.nodeEnv === 'production'));
  app.use(
    '/api/notifications',
    createNotificationsRouter(authService, customerRepo, zabbixClient, config.zabbix),
  );

  app.listen(config.port, () => {
    logger.info(`msp-customer-portal listening on :${config.port}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err);
  process.exit(1);
});
