const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const { createSecureGuardRouter } = require('../dist/routes/secureGuard');

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
