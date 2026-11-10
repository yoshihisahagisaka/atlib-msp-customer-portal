const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const { createSecureGuardRouter } = require('../dist/routes/secureGuard');
const { requireSecureGuardIdentity, requireMspAdmin } = require('../dist/middleware/secureGuardAuth');

async function withApp(admin, run) {
  const app = express(); app.use(express.json()); app.use(cookieParser());
  app.use('/api/secure-guard', createSecureGuardRouter({
    identityService: { verifySession: () => ({ userId: 'msp-user', sessionVersion: 1 }), verifyActiveSession: async () => ({ id: 'msp-user', status: 'active', sessionVersion: 1 }) },
    repo: { hasActiveMspAdminGrant: async () => admin, listManagedOrganizations: async () => [{ id: 'org-1', organizationName: 'Example', status: 'active', dnsfilterOrganizationId: '2001', mappingStatus: 'active' }], listAuditEvents: async () => [], listActiveMemberships: async () => [] },
    inventoryClient: {}, mailer: {}, portalBaseUrl: 'https://portal.example.test',
  }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try { await run(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); }
}

test('MSP organization inventory is available only to an explicit MSP grant', async () => {
  await withApp(true, async (base) => {
    const response = await fetch(`${base}/api/secure-guard/admin/organizations`, { headers: { Cookie: 'secure_guard_session=test' } });
    assert.equal(response.status, 200); assert.equal((await response.json()).organizations[0].organizationName, 'Example');
  });
  await withApp(false, async (base) => {
    const response = await fetch(`${base}/api/secure-guard/admin/organizations`, { headers: { Cookie: 'secure_guard_session=test' } });
    assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: 'MSP_SCOPE_DENIED' });
  });
});

test('management screen never contains an API-key input or secret API route', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'secure-guard-admin.html'), 'utf8');
  const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'secureGuard.ts'), 'utf8');
  assert.doesNotMatch(html, /type="password"/); assert.doesNotMatch(routes, /dnsfilter-key/);
});

test('the management HTML requires both a Secure Guard session and an explicit MSP grant', async () => {
  const identity = { verifySession: () => ({ userId: 'user-1', sessionVersion: 1 }), verifyActiveSession: async () => ({ id: 'user-1', status: 'active', sessionVersion: 1 }) };
  for (const [cookie, grant, expected] of [[undefined, true, 401], ['secure_guard_session=test', false, 403], ['secure_guard_session=test', true, 200]]) {
    const app = express(); app.use(cookieParser());
    app.get('/secure-guard-admin.html', requireSecureGuardIdentity(identity), requireMspAdmin({ hasActiveMspAdminGrant: async () => grant }), (_req, res) => res.status(200).send('ok'));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try { const response = await fetch(`http://127.0.0.1:${server.address().port}/secure-guard-admin.html`, { headers: cookie ? { Cookie: cookie } : {} }); assert.equal(response.status, expected); }
    finally { await new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); }
  }
  const serverSource = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'server.ts'), 'utf8');
  assert.match(serverSource, /secure-guard-admin\.html', requireSecureGuardIdentity\(secureGuardIdentityService\), requireMspAdmin\(secureGuardRepo\)/);
});

test('Organization API keeps only a confirmed unique conflict at 409', async () => {
  async function request(error) {
    const app = express(); app.use(express.json()); app.use(cookieParser());
    app.use('/api/secure-guard', createSecureGuardRouter({
      identityService: { verifySession: () => ({ userId: 'msp-user', sessionVersion: 1 }), verifyActiveSession: async () => ({ id: 'msp-user', status: 'active', sessionVersion: 1 }) },
      repo: { hasActiveMspAdminGrant: async () => true, createManagedOrganization: async () => { if (error) throw error; return { id: 'org-1', organizationName: 'Example', status: 'active', dnsfilterOrganizationId: null, mappingStatus: null }; }, updateManagedOrganization: async () => { if (error) throw error; return null; } }, inventoryClient: {}, mailer: {}, portalBaseUrl: 'https://portal.example.test',
    }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try { const response = await fetch(`http://127.0.0.1:${server.address().port}/api/secure-guard/admin/organizations`, { method: 'POST', headers: { Cookie: 'secure_guard_session=test', 'Content-Type': 'application/json' }, body: JSON.stringify({ organizationName: 'Example' }) }); return { status: response.status, body: await response.json() }; }
    finally { await new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); }
  }
  assert.deepEqual(await request({ code: '23505' }), { status: 409, body: { error: 'ORGANIZATION_CONFLICT' } });
  assert.deepEqual(await request(new Error('database connection failed')), { status: 500, body: { error: 'ORGANIZATION_UNAVAILABLE' } });
  assert.equal((await request(null)).status, 201);
});

test('Site creation requires fixed Policy, Block Page and external ID, and is MSP-only', async () => {
  const site = { name: 'Trial Site', policyIds: ['301'], blockPageId: '402', externalId: 'sg-trial-10222523-1' };
  for (const admin of [true, false]) {
    const calls = []; const audits = [];
    const app = express(); app.use(express.json()); app.use(cookieParser());
    app.use('/api/secure-guard', createSecureGuardRouter({
      identityService: { verifySession: () => ({ userId: 'msp-user', sessionVersion: 1 }), verifyActiveSession: async () => ({ id: 'msp-user', status: 'active', sessionVersion: 1 }) },
      repo: {
        hasActiveMspAdminGrant: async () => admin,
        findActiveDnsFilterOrganization: async () => '10222523',
        recordSystemAudit: async (...args) => { audits.push(args); },
      },
      managementClient: { createNetwork: async (...args) => { calls.push(args); return { id: '501', name: 'Trial Site' }; } },
      inventoryClient: {}, mailer: {}, portalBaseUrl: 'https://portal.example.test',
    }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      const base = `http://127.0.0.1:${server.address().port}/api/secure-guard/admin/organizations/org-1/sites`;
      const post = (body) => fetch(base, { method: 'POST', headers: { Cookie: 'secure_guard_session=test', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const missing = await post({ ...site, blockPageId: undefined });
      assert.equal(missing.status, admin ? 400 : 403);
      const globalPolicyGuess = await post({ ...site, policyIds: [] });
      assert.equal(globalPolicyGuess.status, admin ? 400 : 403);
      const invalidId = await post({ ...site, blockPageId: '402abc' });
      assert.equal(invalidId.status, admin ? 400 : 403);
      const overflowId = await post({ ...site, blockPageId: '9999999999999999999999' });
      assert.equal(overflowId.status, admin ? 400 : 403);
      assert.equal(calls.length, 0);
      const created = await post(site);
      assert.equal(created.status, admin ? 201 : 403);
      if (admin) {
        assert.deepEqual(await created.json(), { id: '501', name: 'Trial Site' });
        assert.deepEqual(calls, [['10222523', site]]);
        assert.equal(audits.length, 1);
        assert.equal(audits[0][1], 'site.created');
      } else assert.equal(calls.length, 0);
    } finally { await new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); }
  }
});

test('Site creation returns an unresolved outcome without a retry when read-back fails', async () => {
  let postCount = 0; const audits = [];
  const app = express(); app.use(express.json()); app.use(cookieParser());
  app.use('/api/secure-guard', createSecureGuardRouter({
    identityService: { verifySession: () => ({ userId: 'msp-user', sessionVersion: 1 }), verifyActiveSession: async () => ({ id: 'msp-user', status: 'active', sessionVersion: 1 }) },
    repo: { hasActiveMspAdminGrant: async () => true, findActiveDnsFilterOrganization: async () => '10222523', recordSystemAudit: async (...args) => { audits.push(args); } },
    managementClient: { createNetwork: async () => { postCount++; throw new Error('GET read-back failed after POST'); } },
    inventoryClient: {}, mailer: {}, portalBaseUrl: 'https://portal.example.test',
  }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/secure-guard/admin/organizations/org-1/sites`, {
      method: 'POST', headers: { Cookie: 'secure_guard_session=test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Trial Site', policyIds: ['301'], blockPageId: '402', externalId: 'sg-trial-10222523-1' }),
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'DNSFILTER_SITE_CREATE_OUTCOME_UNKNOWN' });
    assert.equal(postCount, 1);
    assert.equal(audits[0][1], 'site.creation.unresolved');
  } finally { await new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); }
});
