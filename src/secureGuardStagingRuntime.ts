import path from 'path';
import express from 'express';
import cookieParser from 'cookie-parser';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { readSecureGuardDatabaseSettings, createSecureGuardDatabasePool } from './db/secureGuardDatabase';
import { SecureGuardRepo } from './services/secureGuardRepo';
import { SecureGuardIdentityService } from './services/secureGuardIdentityService';
import { SecureGuardOverageStore } from './services/secureGuardOverageStore';
import { DnsFilterInventoryClient } from './services/dnsFilterInventoryClient';
import { createSecureGuardAuthRouter } from './routes/secureGuardAuth';
import { createSecureGuardRouter } from './routes/secureGuard';
import { requireMspAdmin, requireSecureGuardIdentity } from './middleware/secureGuardAuth';
import { safeHttpLogRedactions, safeHttpLogSerializers } from './lib/httpLog';

/**
 * A restricted Staging profile of the SAME Secure Guard application and router.
 * It is shared by every synthetic tenant; this is not a per-tenant app or database.
 * No legacy Portal config, database, Zabbix, OAuth, SMTP or DNSFilter write client.
 * No real Staging deployment is authorized by this offline implementation.
 */
export async function startIsolatedSecureGuardStaging(): Promise<void> {
  if (process.env.SECURE_GUARD_DB_MODE !== 'dedicated'
    || process.env.SECURE_GUARD_DB_REQUIRE_DEDICATED !== 'true') {
    throw new Error('Isolated Secure Guard Staging requires dedicated database only');
  }
  const settings = readSecureGuardDatabaseSettings(process.env, 'runtime');
  if (!settings) throw new Error('Secure Guard dedicated database unavailable');

  const jwtSecret = process.env.SECURE_GUARD_JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) throw new Error('Missing Secure Guard Staging JWT secret');
  const rawBaseUrl = process.env.SECURE_GUARD_BASE_URL;
  if (!rawBaseUrl) throw new Error('Missing SECURE_GUARD_BASE_URL');
  let base: URL;
  try { base = new URL(rawBaseUrl); } catch { throw new Error('Invalid SECURE_GUARD_BASE_URL'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('SECURE_GUARD_BASE_URL must be an HTTPS origin');
  }
  const port = Number(process.env.PORT ?? '8080');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');

  const pool = createSecureGuardDatabasePool(settings);
  const repo = new SecureGuardRepo(pool);
  const identity = new SecureGuardIdentityService(repo, jwtSecret, '24h');
  const logger = pino({ level: 'info' });
  const app = express();
  app.set('trust proxy', true);
  app.use(pinoHttp({ logger, serializers: safeHttpLogSerializers, redact: safeHttpLogRedactions }));
  app.use(express.json());
  app.use(cookieParser());
  app.get('/healthz', (_req, res) => res.status(200).send('ok'));
  app.get('/', (_req, res) => res.redirect('/secure-guard-login.html'));

  // Reject all business mutations BEFORE loading their handlers (including
  // invitation token creation or a local DNSFilter provisioning draft).
  // Login/logout only mutate an HttpOnly cookie, not a database or remote service.
  app.use('/api/secure-guard', (req, res, next) => {
    const authSession = req.method === 'POST' && (req.path === '/auth/login' || req.path === '/auth/logout');
    if (req.method !== 'GET' && !authSession) {
      res.status(503).json({ error: 'SECURE_GUARD_STAGING_WRITES_DISABLED' });
      return;
    }
    next();
  });
  app.use('/api/secure-guard/auth', createSecureGuardAuthRouter(identity, true));
  app.use('/api/secure-guard', createSecureGuardRouter({
    identityService: identity,
    repo,
    // No DNSFilter credentials in this profile. Inventory and management
    // endpoints fail closed; real integrations require a separate S4 Gate.
    inventoryClient: new DnsFilterInventoryClient(undefined),
    // The global mutation barrier rejects all invitation requests before
    // reaching this fail-closed mailer. No SMTP credentials are loaded.
    mailer: { sendSecureGuardInvitationEmail: async () => { throw new Error('STAGING_MAIL_DISABLED'); } },
    portalBaseUrl: base.origin,
    overageStore: new SecureGuardOverageStore(pool),
    manualLicenseAlertDeliveryEnabled: false,
    agentUninstallEnabled: false,
  }));
  app.get('/secure-guard-login.html', (_req, res) =>
    res.sendFile(path.join(__dirname, '../public/secure-guard-login.html')));
  app.get('/secure-guard-home.html', requireSecureGuardIdentity(identity), (_req, res) =>
    res.sendFile(path.join(__dirname, '../public/secure-guard-home.html')));
  app.get('/secure-guard-admin.html', requireSecureGuardIdentity(identity), requireMspAdmin(repo), (_req, res) =>
    res.sendFile(path.join(__dirname, '../public/secure-guard-admin.html')));
  // The shared Staging profile exposes only Secure Guard assets, not Portal JS.
  app.get('/css/style.css', (_req, res) =>
    res.sendFile(path.join(__dirname, '../public/css/style.css')));
  for (const filename of ['secureGuard.js', 'secureGuardHome.js', 'secureGuardAdmin.js']) {
    app.get(`/js/${filename}`, (_req, res) =>
      res.sendFile(path.join(__dirname, '../public/js', filename)));
  }

  const listener = app.listen(port, () => logger.info('Secure Guard shared Staging profile ready'));
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    } finally {
      await pool.end();
    }
  };
  process.once('SIGTERM', () => { void stop().catch(() => { process.exitCode = 1; }); });
  process.once('SIGINT', () => { void stop().catch(() => { process.exitCode = 1; }); });
}
