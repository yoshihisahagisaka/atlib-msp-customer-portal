const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const { createSecureGuardRouter } = require('../dist/routes/secureGuard');
const { DnsFilterAgentUninstallClient } = require('../dist/services/dnsFilterAgentUninstallClient');

const AGENT_ID = '3b9765d3-5ff7-4a1f-9f8b-f0af1d03e843';
const SCOPE = { membershipId: 'membership-1', customerOrganizationId: 'org-1', organizationName: 'Example', role: 'operator' };
const INVENTORY = { fetchedAt: new Date().toISOString(), sites: [{ id: '42', name: 'Tokyo', agentCount: 1 }],
  agents: [{ id: AGENT_ID, siteId: '42', hostname: 'PC-01', status: 'active', agentState: 'protected' }] };
const BODY = { siteId: '42', hostname: 'PC-01', confirmHostname: 'PC-01', acknowledgeCommunicationRisk: true };
const HEADERS = { Cookie: 'secure_guard_session=test', 'X-Secure-Guard-Membership': 'membership-1', 'Content-Type': 'application/json' };

async function withApp(options, run) {
  const events = [];
  const claims = new Map();
  const repo = {
    findActiveScope: async (_user, membership) => membership === 'membership-1' ? { ...SCOPE, role: options.role || 'operator' } : null,
    findActiveDnsFilterOrganization: async () => options.mapping === undefined ? '300' : options.mapping,
    getAgentUninstallClaim: async (_org, id) => claims.get(id) || null,
    claimAgentUninstall: async (data) => {
      events.push('claim');
      if (options.claimResult) return options.claimResult;
      if (claims.has(data.agentUuid)) return 'duplicate';
      claims.set(data.agentUuid, { id: data.operationId, agentUuid: data.agentUuid, status: 'pending_unknown' });
      return 'claimed';
    },
    finishAgentUninstall: async (id, _user, _scope, status) => {
      events.push('finish:' + status);
      if (options.finishFails) throw new Error('DB_STATUS_UNAVAILABLE');
      for (const claim of claims.values()) if (claim.id === id) { claim.status = status; return true; }
      return false;
    },
  };
  const app = express(); app.use(express.json()); app.use(cookieParser());
  app.use('/api/secure-guard', createSecureGuardRouter({
    identityService: { verifySession: () => ({}), verifyActiveSession: async () => ({ id: 'user-1' }) },
    repo, mailer: {}, portalBaseUrl: 'https://example.test',
    inventoryClient: { getInventory: async () => { events.push('inventory'); if (options.inventoryFails) throw new Error('GET_FAIL'); return options.inventory || INVENTORY; } },
    agentUninstallEnabled: options.enabled !== false,
    agentUninstallClient: { isConfigured: () => options.configured !== false,
      requestQueuedUninstall: async () => { events.push('delete'); if (options.deleteFails) throw new Error('timeout'); } },
  }));
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/secure-guard`;
    const post = (body = BODY, headers = HEADERS) => fetch(`${base}/agents/${AGENT_ID}/queued-uninstall`, { method: 'POST', headers, body: JSON.stringify(body) });
    await run({ base, post, events, claims });
  } finally { await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())); }
}

test('only PoC-verified queue_uninstall=true DELETE, never soft delete and never retry', async () => {
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, init }); return { status: 204 }; };
  const client = new DnsFilterAgentUninstallClient('test-key', fetcher);
  await client.requestQueuedUninstall(AGENT_ID);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.dnsfilter.com/v1/user_agents/${AGENT_ID}?queue_uninstall=true`);
  assert.equal(calls[0].init.method, 'DELETE');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
  for (const status of [200, 202, 403, 404, 500]) {
    let n = 0;
    await assert.rejects(new DnsFilterAgentUninstallClient('key', async () => { n++; return { status }; }).requestQueuedUninstall(AGENT_ID), /OUTCOME_UNKNOWN/);
    assert.equal(n, 1);
  }
  await assert.rejects(new DnsFilterAgentUninstallClient('key', async () => { throw new Error('secret response'); }).requestQueuedUninstall(AGENT_ID), /OUTCOME_UNKNOWN/);
  await assert.rejects(new DnsFilterAgentUninstallClient('key', fetcher).requestQueuedUninstall('../bad'), /UNAVAILABLE/);
});

test('default OFF and missing API key fail closed before inventory or deletion', async () => {
  for (const options of [{ enabled: false }, { configured: false }]) {
    await withApp(options, async ({ post, events }) => {
      const response = await post();
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error, 'AGENT_UNINSTALL_NOT_ENABLED');
      assert.deepEqual(events, []);
    });
  }
});

test('viewer and forged Membership cannot submit even with a UUID', async () => {
  await withApp({ role: 'viewer' }, async ({ post, events }) => {
    assert.equal((await post()).status, 403);
    assert.deepEqual(events, []);
  });
  await withApp({}, async ({ post, events }) => {
    assert.equal((await post(BODY, { ...HEADERS, 'X-Secure-Guard-Membership': 'other-org' })).status, 403);
    assert.deepEqual(events, []);
  });
});

test('fresh full inventory must match Agent UUID, Site and hostname, with explicit acknowledgement', async () => {
  for (const body of [{ ...BODY, siteId: '43' }, { ...BODY, hostname: 'other', confirmHostname: 'other' },
    { ...BODY, confirmHostname: 'other' }, { ...BODY, acknowledgeCommunicationRisk: false }]) {
    await withApp({}, async ({ post, events }) => {
      assert.ok([400, 409].includes((await post(body)).status));
      assert.equal(events.includes('delete'), false);
      assert.equal(events.includes('claim'), false);
    });
  }
  await withApp({ inventoryFails: true }, async ({ post, events }) => {
    assert.equal((await post()).status, 503);
    assert.deepEqual(events, ['inventory']);
  });
  await withApp({ mapping: null }, async ({ post, events }) => {
    assert.equal((await post()).status, 409);
    assert.deepEqual(events, []);
  });
});

test('durable claim is acquired before exactly one DELETE, 204 means accepted but device not completed', async () => {
  await withApp({}, async ({ post, events, base }) => {
    const first = await post();
    assert.equal(first.status, 202);
    const body = await first.json();
    assert.equal(body.status, 'accepted');
    assert.equal(body.deviceUninstallCompleted, false);
    assert.deepEqual(events, ['inventory', 'claim', 'delete', 'finish:accepted']);
    const status = await fetch(`${base}/agents/${AGENT_ID}/uninstall-status`, { headers: HEADERS });
    assert.equal((await status.json()).claim.status, 'accepted');
    const second = await post();
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error, 'AGENT_UNINSTALL_ALREADY_CLAIMED_NO_RETRY');
    assert.equal(events.filter((event) => event === 'delete').length, 1);
  });
});

test('timeout or status write failure yields UNKNOWN with durable claim and no second DELETE', async () => {
  for (const options of [{ deleteFails: true }, { finishFails: true }]) {
    await withApp(options, async ({ post, events }) => {
      const first = await post();
      assert.equal(first.status, 503);
      assert.equal((await first.json()).error, 'AGENT_UNINSTALL_OUTCOME_UNKNOWN_NO_RETRY');
      assert.equal((await post()).status, 409);
      assert.equal(events.filter((event) => event === 'delete').length, 1);
    });
  }
});

test('DB denial or failure prevents upstream write', async () => {
  for (const claimResult of ['denied', 'duplicate']) {
    await withApp({ claimResult }, async ({ post, events }) => {
      assert.equal((await post()).status, claimResult === 'denied' ? 403 : 409);
      assert.equal(events.includes('delete'), false);
    });
  }
});

test('dedicated migrations preserve license snapshot + global UUID uniqueness, legacy schema untouched and audit atomic', () => {
  const migration = fs.readFileSync('migrations/secure_guard/004_agent_uninstall_claims.sql', 'utf8');
  const license = fs.readFileSync('migrations/secure_guard/003_license_alert_snapshot.sql', 'utf8');
  const legacyLicense = fs.readFileSync('migrations/013_secure_guard_license_alert_snapshot.sql', 'utf8');
  const repo = fs.readFileSync('src/services/secureGuardRepo.ts', 'utf8');
  const server = fs.readFileSync('src/server.ts', 'utf8');
  assert.match(migration, /agent_uuid UUID NOT NULL UNIQUE/);
  assert.match(migration, /pending_unknown/);
  assert.match(migration, /dedicated migrations\/secure_guard_runner/);
  assert.equal(license.slice(license.indexOf('ALTER TABLE')).trimEnd(), legacyLicense.trimEnd());
  assert.ok('003_license_alert_snapshot.sql' < '004_agent_uninstall_claims.sql');
  assert.equal(fs.existsSync('migrations/014_secure_guard_agent_uninstall_claims.sql'), false);
  assert.match(server, /SECURE_GUARD_DB_MODE === 'dedicated'/);
  assert.match(server, /SECURE_GUARD_DB_REQUIRE_DEDICATED === 'true'/);
  assert.match(repo, /'agent\.uninstall\.claimed', 'success'/);
  assert.match(repo, /'COMMIT'/);
  assert.match(repo, /FOR SHARE OF m, u, o, d/);
});
