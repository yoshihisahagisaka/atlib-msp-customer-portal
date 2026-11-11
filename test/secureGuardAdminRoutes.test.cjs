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

test('MSP auto-sync requires an MSP grant, rejects supplied IDs, and never writes when upstream GET fails', async () => {
  for (const mode of ['non-admin', 'supplied-ids', 'upstream-failure', 'empty-success']) {
    let upstreamCalls = 0; let databaseWrites = 0;
    const app = express(); app.use(express.json()); app.use(cookieParser());
    app.use('/api/secure-guard', createSecureGuardRouter({
      identityService: { verifySession: () => ({ userId: 'msp-user', sessionVersion: 1 }), verifyActiveSession: async () => ({ id: 'msp-user', status: 'active', sessionVersion: 1 }) },
      repo: {
        hasActiveMspAdminGrant: async () => mode !== 'non-admin',
        listManagedOrganizations: async () => [],
        createManagedOrganization: async () => { databaseWrites++; throw new Error('Unexpected local write'); },
        recordSystemAudit: async () => { databaseWrites++; },
      },
      managementClient: { listOrganizations: async () => { upstreamCalls++; if (mode === 'upstream-failure') throw new Error('page 2 failed'); return []; } },
      inventoryClient: {}, mailer: {}, portalBaseUrl: 'https://portal.example.test',
    }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/secure-guard/admin/dnsfilter/organizations/sync`, {
        method: 'POST', headers: { Cookie: 'secure_guard_session=test', 'Content-Type': 'application/json' },
        body: mode === 'supplied-ids' ? JSON.stringify({ organizationIds: ['10222523'] }) : '{}',
      });
      assert.equal(response.status, mode === 'non-admin' ? 403 : mode === 'supplied-ids' ? 400 : mode === 'upstream-failure' ? 502 : 200);
      assert.equal(upstreamCalls, ['non-admin', 'supplied-ids'].includes(mode) ? 0 : 1);
      assert.equal(databaseWrites, 0);
      if (mode === 'empty-success') assert.deepEqual((await response.json()).sync, { imported: 0, skipped: 0, failed: 0, needsReview: 0, issues: [] });
    } finally { await new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); }
  }
});

test('management screen never contains an API-key input or secret API route', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'secure-guard-admin.html'), 'utf8');
  const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'secureGuard.ts'), 'utf8');
  assert.doesNotMatch(html, /type="password"/); assert.doesNotMatch(routes, /dnsfilter-key/);
});

test('MSP normal UI no longer asks operators to choose Global Policy or Block Page IDs', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'secure-guard-admin.html'), 'utf8');
  assert.doesNotMatch(html, /site-policy|site-block-page-id|site-external-id/);
  assert.match(html, /managed-organization-select/);
});

test('trial Site preflight is restricted to one known Organization and GET-only requests', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const ps = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'secure-guard-trial-site-readonly-preflight.ps1'), 'utf8');
  assert.match(ps, /\$organizationId = '10222523'/);
  assert.match(ps, /\$expectedMspId = '11473'/);
  assert.match(ps, /Invoke-RestMethod -Method GET/);
  assert.match(ps, /-MaximumRedirection 0/);
  assert.match(ps, /INCOMPLETE_\$\(\$check\.Name\)_PAGINATION/);
  assert.doesNotMatch(ps, /-Method\s+(POST|PUT|PATCH|DELETE)/i);
  assert.doesNotMatch(ps, /(Write-Output|Write-Host)\s+\$\s*(apiKey|headers|organization|response)/i);
});

test('trial Site preflight emits fixed failure stage without leaking HTTP errors or secrets', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const ps = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'secure-guard-trial-site-readonly-preflight.ps1'), 'utf8');
  for (const stage of ['SECRET_ACCESS', 'ORGANIZATION_GET', 'ORGANIZATION_VALIDATE', 'POLICY', 'BLOCK_PAGE', 'SITE']) {
    assert.match(ps, new RegExp(stage));
  }
  assert.match(ps, /\$completedGetCount\+\+/);
  assert.match(ps, /"CompletedGetCount":/);
  assert.match(ps, /\[Console\]::Out\.Flush\(\)/);
  assert.match(ps, /ConvertTo-Json -Compress -Depth 4/);
  assert.match(ps, /Pagination=\$\(if \(\$complete\)/);
  assert.doesNotMatch(ps, /Pagination=if\s*\(/);
  assert.match(ps, /\$failure = \$_\.Exception/);
  assert.match(ps, /\$statusCode -ge 100 -and \$statusCode -le 599/);
  assert.match(ps, /'NO_HTTP_RESPONSE'/);
  assert.match(ps, /'PARAMETER_BINDING'/);
  assert.match(ps, /'TLS_FAILURE'/);
  assert.match(ps, /'\/v1\/organizations\/\{0\}\?include_current_mrr=true' -f \$organizationId/);
  assert.doesNotMatch(ps, /(?:Write-Output|Write-Host|\[Console\]::Out\.WriteLine)\([^)]*(?:\$failure(?!\w)|\$_\.(?:Exception|ErrorDetails|InvocationInfo))/);
  assert.doesNotMatch(ps, /(?:Exception\.Message|Response\.Content|GetResponseStream\()/);
  assert.doesNotMatch(ps, /(Write-Output|Write-Host)\s+\$\s*(apiKey|headers|organization|response)/i);
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
