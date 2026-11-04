import { loadConfig } from '../config';
import { createPool } from '../db/pool';
import { SecureGuardRepo } from '../services/secureGuardRepo';
import { DnsFilterRoamingUsageClient } from '../services/dnsFilterRoamingUsageClient';
import { SecureGuardOverageStore } from '../services/secureGuardOverageStore';
import { runSecureGuardOverageCheck } from '../services/secureGuardOverageMonitor';

/** One opt-in iteration; no process-level cron, no automatic migration or DNSFilter changes. */
async function main(): Promise<void> {
  if (process.env.SECURE_GUARD_OVERAGE_JOB_ENABLED !== 'true') {
    console.error('Secure Guard overage job is disabled. Explicit Go/No-Go required.');
    process.exitCode = 2;
    return;
  }
  const config = await loadConfig();
  const pool = createPool(config);
  try {
    const result = await runSecureGuardOverageCheck({
      repo: new SecureGuardRepo(pool),
      client: new DnsFilterRoamingUsageClient(config.gcpProjectId),
      store: new SecureGuardOverageStore(pool),
      slackWebhook: config.slack.webhookSecureGuardOverage,
      managementUrl: config.portalBaseUrl + '/secure-guard-admin.html',
    });
    // No credentials, Organization names or per-customer payloads in job output.
    console.log(JSON.stringify({ job: 'secure-guard-overage', ...result }));
    if (result.unavailable || result.notificationsNeedReview) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  // Never expose a secret in an unhandled database, DNSFilter or Slack exception.
  console.error('Secure Guard overage job failed. Review restricted service logs.');
  process.exitCode = 1;
});
