const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const fs = require('node:fs');
const path = require('node:path');
const { SecureGuardLicenseSlack } = require('../dist/services/secureGuardLicenseSlack');
const { createSecureGuardRouter } = require('../dist/routes/secureGuard');

test('dedicated Slack adapter sends nothing when unconfigured and reports failures safely', async () => {
  let calls = 0;
  const unconfigured = new SecureGuardLicenseSlack(undefined, async () => { calls += 1; throw new Error('must not run'); });
  const alert = { organizationName: 'Example', usage: 4, allocation: 2, overage: 2, checkedAt: '2026-11-10T00:00:00.000Z' };
  assert.equal(await unconfigured.send(alert), 'unconfigured'); assert.equal(calls, 0);
  const failed = new SecureGuardLicenseSlack('https://hooks.slack.invalid/private', async () => { calls += 1; return { ok: false }; });
  assert.equal(await failed.send(alert), 'failed'); assert.equal(calls, 1);
});

test('Slack payload contains only the bounded alert projection', async () => {
  let request;
  const notifier = new SecureGuardLicenseSlack('https://hooks.slack.invalid/private', async (url, init) => { request = { url, init }; return { ok: true }; });
  assert.equal(await notifier.send({ organizationName: 'Example', usage: 4, allocation: 2, overage: 2, checkedAt: '2026-11-10T00:00:00.000Z', portalUrl: 'https://portal.example.test/secure-guard-admin.html' }), 'sent');
  assert.match(request.init.body, /Example/); assert.doesNotMatch(request.init.body, /Agent|Authorization|secret|UUID/i);
});

async function withAlertApp({ usage, allocation, configured = true, delivery = 'sent' }, run) {
  let sends = 0; let claimed = false;
  const repo = {
    hasActiveMspAdminGrant: async () => true,
    getLicenseAlertState: async () => ({ organizationId: 'org-1', organizationName: 'Example', dnsfilterOrganizationId: '10222523', allocatedLicenses: allocation, licenseSnapshotUpdatedAt: '2026-11-10T00:00:00.000Z' }),
    claimLicenseAlert: async () => { if (claimed) return 'duplicate'; claimed = true; return 'claimed'; },
    completeLicenseAlert: async () => true,
    failLicenseAlert: async () => { claimed = false; },
    clearResolvedLicenseAlert: async () => {},
  };
  const app = express(); app.use(express.json()); app.use(cookieParser());
  app.use('/api/secure-guard', createSecureGuardRouter({
    identityService: { verifySession: () => ({ userId: 'msp-user', sessionVersion: 1 }), verifyActiveSession: async () => ({ id: 'msp-user', status: 'active', sessionVersion: 1 }) },
    repo, inventoryClient: {}, mailer: {}, portalBaseUrl: 'https://portal.example.test',
    managementClient: { getOrganizationLicenseUsage: async () => ({ usage, checkedAt: '2026-11-10T00:00:00.000Z' }) },
    licenseAlertSlack: { isConfigured: () => configured, send: async () => { sends += 1; return delivery; } },
  }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try { await run(`http://127.0.0.1:${server.address().port}`, () => sends); } finally { await new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); }
}

test('UNKNOWN and unconfigured Slack never send', async () => {
  await withAlertApp({ usage: null, allocation: 2 }, async (base, sends) => { const r = await fetch(`${base}/api/secure-guard/admin/organizations/org-1/license-alerts/check`, { method: 'POST', headers: { Cookie: 'secure_guard_session=test' } }); assert.equal((await r.json()).notification, 'not_sent_unknown'); assert.equal(sends(), 0); });
  await withAlertApp({ usage: 4, allocation: 2, configured: false }, async (base, sends) => { const r = await fetch(`${base}/api/secure-guard/admin/organizations/org-1/license-alerts/check`, { method: 'POST', headers: { Cookie: 'secure_guard_session=test' } }); assert.equal((await r.json()).notification, 'not_configured'); assert.equal(sends(), 0); });
});

test('same overage is sent once and duplicate is suppressed', async () => {
  await withAlertApp({ usage: 4, allocation: 2 }, async (base, sends) => {
    const headers = { Cookie: 'secure_guard_session=test' };
    const first = await fetch(`${base}/api/secure-guard/admin/organizations/org-1/license-alerts/check`, { method: 'POST', headers });
    const second = await fetch(`${base}/api/secure-guard/admin/organizations/org-1/license-alerts/check`, { method: 'POST', headers });
    assert.equal((await first.json()).notification, 'sent'); assert.equal((await second.json()).notification, 'duplicate_suppressed'); assert.equal(sends(), 1);
  });
});

test('failed Slack delivery is not recorded as sent', async () => {
  await withAlertApp({ usage: 4, allocation: 2, delivery: 'failed' }, async (base, sends) => { const r = await fetch(`${base}/api/secure-guard/admin/organizations/org-1/license-alerts/check`, { method: 'POST', headers: { Cookie: 'secure_guard_session=test' } }); assert.equal((await r.json()).notification, 'failed'); assert.equal(sends(), 1); });
});

test('only an MSP admin can record an allocation snapshot and no DNSFilter write occurs', async () => {
  for (const [admin, expected] of [[false, 403], [true, 200]]) {
    let updates = 0; let dnsCalls = 0;
    const app = express(); app.use(express.json()); app.use(cookieParser());
    app.use('/api/secure-guard', createSecureGuardRouter({
      identityService: { verifySession: () => ({ userId: 'msp-user', sessionVersion: 1 }), verifyActiveSession: async () => ({ id: 'msp-user', status: 'active', sessionVersion: 1 }) },
      repo: { hasActiveMspAdminGrant: async () => admin, updateLicenseAllocation: async (_actor, _org, value) => { updates += 1; return { organizationId: 'org-1', organizationName: 'Example', dnsfilterOrganizationId: '10222523', allocatedLicenses: value, licenseSnapshotUpdatedAt: '2026-11-10T00:00:00.000Z' }; } },
      inventoryClient: {}, mailer: {}, portalBaseUrl: 'https://portal.example.test', managementClient: { request: async () => { dnsCalls += 1; } },
    }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try { const response = await fetch(`http://127.0.0.1:${server.address().port}/api/secure-guard/admin/organizations/org-1/license-allocation`, { method: 'PATCH', headers: { Cookie: 'secure_guard_session=test', 'Content-Type': 'application/json' }, body: JSON.stringify({ allocatedLicenses: 5 }) }); assert.equal(response.status, expected); }
    finally { await new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); }
    assert.equal(updates, admin ? 1 : 0); assert.equal(dnsCalls, 0);
  }
});

test('migration keeps allocation optional and records bounded deduplication state', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '013_secure_guard_license_alert_snapshot.sql'), 'utf8');
  assert.match(sql, /dnsfilter_allocated_rc_licenses_snapshot INTEGER/);
  assert.match(sql, /license_alert_pending_token UUID/);
  assert.doesNotMatch(sql, /dnsfilter_allocated_rc_licenses_snapshot INTEGER NOT NULL/);
});
