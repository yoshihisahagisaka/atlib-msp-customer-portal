import type { PoolClient } from 'pg';
import { readSecureGuardDatabaseSettings, createSecureGuardDatabasePool } from '../db/secureGuardDatabase';
import { SecureGuardRepo } from '../services/secureGuardRepo';
import { DnsFilterRoamingUsageClient } from '../services/dnsFilterRoamingUsageClient';
import { SecureGuardOverageStore } from '../services/secureGuardOverageStore';
import { runSecureGuardOverageCheck } from '../services/secureGuardOverageMonitor';

// Dedicated session lock prevents two scheduled iterations from racing with each other.
// Keep the key stable; use no per-customer/ad hoc locks.
const monitorLockKey = '6004588700000104';

/** Job-only configuration: never resolve Portal DB, Zabbix, SMTP or staff login secrets. */
function readOverageJobConfig(env: NodeJS.ProcessEnv): {
  projectId: string; slackWebhook?: string; managementUrl?: string;
} {
  const managementUrl = env.SECURE_GUARD_MANAGEMENT_URL?.trim() || undefined;
  if (managementUrl) {
    let url: URL;
    try { url = new URL(managementUrl); }
    catch { throw new Error('Invalid Secure Guard management URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw new Error('Invalid Secure Guard management URL');
    }
  }
  return {
    projectId: env.GCP_PROJECT_ID ?? 'msp-zabbix',
    slackWebhook: env.SECURE_GUARD_LICENSE_ALERT_SLACK_WEBHOOK || undefined,
    managementUrl,
  };
}

/** One opt-in iteration; no process-level cron, no automatic migration or DNSFilter changes. */
async function main(): Promise<void> {
  if (process.env.SECURE_GUARD_OVERAGE_JOB_ENABLED !== 'true') {
    console.error('Secure Guard overage job is disabled. Explicit Go/No-Go required.');
    process.exitCode = 2;
    return;
  }
  const config = readOverageJobConfig(process.env);
  // Overage history must not write into the saturated legacy Portal database.
  const secureGuardSettings = readSecureGuardDatabaseSettings(process.env, 'overage');
  if (!secureGuardSettings) {
    throw new Error('Dedicated Secure Guard database required for overage job');
  }
  const pool = createSecureGuardDatabasePool(secureGuardSettings);
  let lease: PoolClient | undefined;
  let lockHeld = false;
  try {
    lease = await pool.connect();
    const acquired = await lease.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [monitorLockKey]);
    if (acquired.rows[0]?.acquired !== true) {
      console.log(JSON.stringify({ job: 'secure-guard-overage', result: 'skipped_already_running' }));
      return;
    }
    lockHeld = true;
    const result = await runSecureGuardOverageCheck({
      repo: new SecureGuardRepo(pool),
      client: new DnsFilterRoamingUsageClient(config.projectId),
      store: new SecureGuardOverageStore(pool),
      slackWebhook: config.slackWebhook,
      managementUrl: config.managementUrl,
    });
    // No credentials, Organization names or per-customer payloads in job output.
    console.log(JSON.stringify({ job: 'secure-guard-overage', ...result }));
    if (result.unavailable || result.notificationsNeedReview) process.exitCode = 1;
  } finally {
    if (lease) {
      if (lockHeld) {
        try {
          const unlocked = await lease.query('SELECT pg_advisory_unlock($1::bigint) AS released', [monitorLockKey]);
          if (unlocked.rows[0]?.released !== true) process.exitCode = 1;
        } catch { process.exitCode = 1; }
      }
      lease.release();
    }
    await pool.end();
  }
}

main().catch(() => {
  // Never expose a secret in an unhandled database, DNSFilter or Slack exception.
  console.error('Secure Guard overage job failed. Review restricted service logs.');
  process.exitCode = 1;
});
