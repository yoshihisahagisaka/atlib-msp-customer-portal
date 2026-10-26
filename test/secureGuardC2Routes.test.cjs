const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const { createSecureGuardRouter } = require('../dist/routes/secureGuard');

const scope = { membershipId: 'membership-1', customerOrganizationId: 'org-1', organizationName: 'Example', role: 'viewer' };
const projection = {
  observedAt: '2026-10-25T01:02:03.000Z', completedAt: '2026-10-25T01:03:03.000Z', sourceSha: 'a'.repeat(40), planHash: 'b'.repeat(64), generation: '123', mode: 'DryRun', mutations: 0, siteCount: 1, agentCount: 1,
  sites: [{ displayOrder: 1, agentCount: 1 }], agents: [{ displayOrder: 1, siteDisplayOrder: 1, status: 'active', agentState: 'protected' }],
};

async function withApp(repo, run) {
  const app = express();
  app.use(cookieParser());
  app.use('/api/secure-guard', createSecureGuardRouter({
    identityService: { verifySession: () => ({ userId: 'user-1', sessionVersion: 1 }), verifyActiveSession: async () => ({ id: 'user-1', status: 'active', sessionVersion: 1 }) },
    repo, mailer: {}, portalBaseUrl: 'https://portal.example.test',
  }));
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  try { await run(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

function repoFor(value) {
  return {
    findActiveScope: async (userId, membershipId) => userId === 'user-1' && membershipId === 'membership-1' ? scope : null,
    findLatestVerifiedC2Projection: async () => value,
  };
}

test('C2 routes return only the authorized customer projection and not receipt internals', async () => {
  await withApp(repoFor(projection), async (base) => {
    const headers = { Cookie: 'secure_guard_session=test', 'X-Secure-Guard-Membership': 'membership-1' };
    const overview = await fetch(`${base}/api/secure-guard/overview`, { headers });
    assert.equal(overview.status, 200);
    const body = await overview.json();
    assert.deepEqual(body.observation, { status: 'verified', observedAt: projection.observedAt, mode: 'DryRun', mutations: 0, siteCount: 1, agentCount: 1 });
    assert.equal(JSON.stringify(body).includes(projection.planHash), false);
    const sites = await fetch(`${base}/api/secure-guard/sites`, { headers });
    assert.deepEqual(await sites.json(), { observedAt: projection.observedAt, sites: projection.sites });
  });
});

test('a forged customer scope cannot access another organization projection', async () => {
  await withApp(repoFor(projection), async (base) => {
    const response = await fetch(`${base}/api/secure-guard/sites`, { headers: { Cookie: 'secure_guard_session=test', 'X-Secure-Guard-Membership': 'other-membership' } });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'CUSTOMER_SCOPE_DENIED' });
  });
});

test('missing, unverified, or unavailable receipt data never becomes a successful inventory response', async () => {
  for (const value of [null, new Error('storage unavailable')]) {
    const repo = value instanceof Error ? { ...repoFor(null), findLatestVerifiedC2Projection: async () => { throw value; } } : repoFor(value);
    await withApp(repo, async (base) => {
      const headers = { Cookie: 'secure_guard_session=test', 'X-Secure-Guard-Membership': 'membership-1' };
      const overview = await fetch(`${base}/api/secure-guard/overview`, { headers });
      assert.deepEqual((await overview.json()).observation, { status: 'unavailable' });
      const sites = await fetch(`${base}/api/secure-guard/sites`, { headers });
      assert.equal(sites.status, 503);
      assert.deepEqual(await sites.json(), { error: 'C2_RECEIPT_UNAVAILABLE' });
    });
  }
});
