const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const { createSecureGuardRouter } = require('../dist/routes/secureGuard');

const scope = { membershipId: 'membership-1', customerOrganizationId: 'customer-org-1', organizationName: 'Example', role: 'viewer' };
const inventory = { fetchedAt: '2026-10-27T00:00:00.000Z', sites: [{ id: 'site-a', name: 'Tokyo', agentCount: 1, policy: null }], agents: [{ id: 'agent-a', hostname: 'pc-a', siteId: 'site-a', status: 'active', agentState: 'protected' }] };

async function withApp(repo, inventoryClient, run) {
  const app = express(); app.use(cookieParser());
  app.use('/api/secure-guard', createSecureGuardRouter({
    identityService: { verifySession: () => ({ userId: 'user-1', sessionVersion: 1 }), verifyActiveSession: async () => ({ id: 'user-1', status: 'active', sessionVersion: 1 }) },
    repo, inventoryClient, mailer: {}, portalBaseUrl: 'https://portal.example.test',
  }));
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  try { await run(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

function repo(mapping = '2001') { return { findActiveScope: async (user, membership) => user === 'user-1' && membership === 'membership-1' ? scope : null, findActiveDnsFilterOrganization: async () => mapping }; }

test('one overview screen request returns the same Membership-scoped Site and Agent inventory', async () => {
  const calls = [];
  await withApp(repo(), { getInventory: async (id) => { calls.push(id); return inventory; } }, async (base) => {
    const headers = { Cookie: 'secure_guard_session=test', 'X-Secure-Guard-Membership': 'membership-1' };
    const overview = await fetch(`${base}/api/secure-guard/overview`, { headers });
    const body = await overview.json();
    assert.deepEqual(body.protection, { 'active/protected': 1 });
    assert.deepEqual(body.sites, inventory.sites);
    assert.deepEqual(body.agents, inventory.agents);
  });
  assert.deepEqual(calls, ['2001']);
});

test('cross-customer selection, a missing mapping, and upstream read failure are denied without inventory data', async () => {
  await withApp(repo(), { getInventory: async () => inventory }, async (base) => {
    const response = await fetch(`${base}/api/secure-guard/sites`, { headers: { Cookie: 'secure_guard_session=test', 'X-Secure-Guard-Membership': 'forged' } });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'CUSTOMER_SCOPE_DENIED' });
  });
  for (const client of [{ getInventory: async () => inventory }, { getInventory: async () => { throw new Error('upstream'); } }]) {
    await withApp(repo(null), client, async (base) => {
      const response = await fetch(`${base}/api/secure-guard/overview`, { headers: { Cookie: 'secure_guard_session=test', 'X-Secure-Guard-Membership': 'membership-1' } });
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), { error: 'SECURE_GUARD_DATA_UNAVAILABLE' });
    });
  }
});

test('an MSP administrator without a Customer Membership can read only the neutral account state', async () => {
  const administrator = {
    listActiveMemberships: async () => [],
    hasActiveMspAdminGrant: async () => true,
  };
  await withApp(administrator, { getInventory: async () => assert.fail('must not load inventory') }, async (base) => {
    const response = await fetch(`${base}/api/secure-guard/me`, { headers: { Cookie: 'secure_guard_session=test' } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { memberships: [], mspAdmin: true });
  });
});
