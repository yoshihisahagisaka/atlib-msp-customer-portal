const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const { DnsFilterRoamingUsageClient } = require('../dist/services/dnsFilterRoamingUsageClient');
const { compareConfirmedLicenseUsage } = require('../dist/services/secureGuardLicenseOverage');
const { createSecureGuardRouter } = require('../dist/routes/secureGuard');

const observed = new Date('2026-11-04T06:00:00.000Z');
const data = (id, allocated, usage) => ({
  organization_id: Number(id), plan: 'Core', term: 'Monthly',
  allocated_roaming_clients: allocated, roaming_clients_in_use: usage,
  network_traffic_in_use: 0, user_count: 1,
});
const ok = (body) => ({ ok: true, status: 200, json: async () => ({ data: body }) });

test('official GET returns the two exact GUI-matched fields, with zero usage preserved', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    const org = url.match(/organization_usage_detailed\/(\d+)/)?.[1];
    return ok(org === '10220954' ? data(org, 1, 2) : data(org, 3, 0));
  };
  const client = new DnsFilterRoamingUsageClient('test', async () => 'test-token', fetcher, () => observed);
  const core = await client.getRoamingUsage('10220954');
  const plus = await client.getRoamingUsage('10222523');
  assert.equal(core.roamingClientsInUse, 2);
  assert.equal(core.dnsfilterAllocatedRoamingClients, 1);
  assert.equal(plus.roamingClientsInUse, 0);
  assert.equal(plus.dnsfilterAllocatedRoamingClients, 3);
  assert.equal(compareConfirmedLicenseUsage(core.roamingClientsInUse, core.dnsfilterAllocatedRoamingClients).overBy, 1);
  assert.equal(compareConfirmedLicenseUsage(plus.roamingClientsInUse, plus.dnsfilterAllocatedRoamingClients).status, 'within_allocation');
  for (const request of calls) {
    assert.equal(request.init.method, 'GET');
    assert.equal(request.init.headers.Authorization, 'Bearer test-token');
    assert.match(request.url, /from=2026-10-28/);
    assert.match(request.url, /to=2026-11-04/);
    assert.match(request.url, /^https:\/\/api\.dnsfilter\.com\/v1\/metrics\/organization_usage_detailed\//);
  }
});

test('wrong Organization, missing numbers and unexpected responses fail closed', async () => {
  const check = async (body, response = ok(body)) =>
    new DnsFilterRoamingUsageClient('test', () => 'test-token', async () => response, () => observed)
      .getRoamingUsage('10220954');
  for (const invalid of [
    data('10222523', 1, 2),
    { ...data('10220954', 1, 2), roaming_clients_in_use: undefined },
    { ...data('10220954', 1, 2), allocated_roaming_clients: '1' },
    { ...data('10220954', 1, 2), allocated_roaming_clients: -1 },
    { ...data('10220954', 1, 2), roaming_clients_in_use: 2.5 },
  ]) await assert.rejects(check(invalid), /DNSFILTER_ROAMING_USAGE_UNAVAILABLE/);
  await assert.rejects(check(null, { ok: false, status: 400, json: async () => null }), /DNSFILTER_ROAMING_USAGE_UNAVAILABLE/);
  await assert.rejects(check(null, { ok: true, status: 200, json: async () => ({ data: [] }) }), /DNSFILTER_ROAMING_USAGE_UNAVAILABLE/);
  await assert.rejects(new DnsFilterRoamingUsageClient('test', () => 'test-token').getRoamingUsage('../other'), /DNSFILTER_ROAMING_USAGE_UNAVAILABLE/);
  await assert.rejects(new DnsFilterRoamingUsageClient('test', () => { throw new Error('secret'); }).getRoamingUsage('10220954'), /DNSFILTER_ROAMING_USAGE_UNAVAILABLE/);
});

async function withApp(grant, organizations, usageClient, run) {
  const app = express();
  app.use(cookieParser());
  app.use('/api/secure-guard', createSecureGuardRouter({
    identityService: {
      verifySession: () => ({ userId: 'msp-user', sessionVersion: 1 }),
      verifyActiveSession: async () => ({ id: 'msp-user', status: 'active', sessionVersion: 1 }),
    },
    repo: { hasActiveMspAdminGrant: async () => grant, listManagedOrganizations: async () => organizations },
    inventoryClient: {}, roamingUsageClient: usageClient, mailer: {}, portalBaseUrl: 'https://portal.example.test',
  }));
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  try { await run('http://127.0.0.1:' + server.address().port); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

const orgId = '11111111-1111-4111-8111-111111111111';
const org = { id: orgId, status: 'active', mappingStatus: 'active', dnsfilterOrganizationId: '10220954' };
const path = '/api/secure-guard/admin/organizations/' + orgId + '/roaming-license-usage';
const headers = { Cookie: 'secure_guard_session=test' };

test('MSP-only API exposes official counts and never uses manually entered allocation', async () => {
  const seen = [];
  const client = { getRoamingUsage: async (id) => {
    seen.push(id);
    return { roamingClientsInUse: 2, dnsfilterAllocatedRoamingClients: 1,
      retrievedAt: observed.toISOString(), from: '2026-10-28', to: '2026-11-04' };
  } };
  await withApp(true, [{ ...org, allocatedRcLicensesSnapshot: 99 }], client, async (base) => {
    const response = await fetch(base + path, { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      organizationId: orgId, source: 'dnsfilter.organization_usage_detailed',
      allocated: 1, usage: 2, status: 'overage', overBy: 1,
      observedAt: observed.toISOString(), periodFrom: '2026-10-28', periodTo: '2026-11-04',
    });
  });
  assert.deepEqual(seen, ['10220954']);
  await withApp(false, [org], client, async (base) => {
    const response = await fetch(base + path, { headers });
    assert.equal(response.status, 403);
  });
  assert.equal(seen.length, 1);
});

test('missing, disabled, or invalid mapping and upstream failure never claim a count', async () => {
  let calls = 0;
  const client = { getRoamingUsage: async () => { calls += 1; throw Error('upstream secret'); } };
  for (const organizations of [[], [{ ...org, status: 'suspended' }], [{ ...org, mappingStatus: 'disabled' }]]) {
    await withApp(true, organizations, client, async (base) => {
      const response = await fetch(base + path, { headers });
      assert.equal(response.status, 404);
    });
  }
  assert.equal(calls, 0);
  await withApp(true, [org], client, async (base) => {
    const response = await fetch(base + path, { headers });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'ROAMING_USAGE_UNAVAILABLE' });
  });
  assert.equal(calls, 1);
});
