const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const { createSecureGuardRouter } = require('../dist/routes/secureGuard');

const orgA = '11111111-1111-4111-8111-111111111111';
const orgB = '22222222-2222-4222-8222-222222222222';
const agentId = '33333333-3333-4333-8333-333333333333';
const observedAt = '2026-11-18T00:00:00.000Z';

// This is an isolated HTTP contract rehearsal, NOT Staging DB or Cloud Run E2E.
// Every integration boundary is a local fixture; no GCP, DNSFilter, Slack or SMTP is touched.
test('S4 offline journey isolates two tenants and keeps a fixed synthetic flow free of external writes', async () => {
  const calls = { inventory: [], officialUsage: [], handling: [], agentUninstall: 0, claims: 0,
    slack: 0, email: 0, dnsfilterWrites: 0, allocation: [] };
  const alert = { id: '12', organizationId: orgA, organizationName: 'Synthetic A', overBy: 1, status: 'open' };
  const inventory = {
    fetchedAt: observedAt,
    sites: [{ id: '201', name: 'Synthetic Site A', agentCount: 1, policy: null }],
    agents: [{ id: agentId, hostname: 'synthetic-a-pc', siteId: '201', status: 'active', agentState: 'protected' }],
  };
  const inventoryB = {
    fetchedAt: observedAt,
    sites: [{ id: '202', name: 'Synthetic Site B', agentCount: 0, policy: null }],
    agents: [],
  };
  const scopeA = { membershipId: 'membership-a', customerOrganizationId: orgA,
    organizationName: 'Synthetic A', role: 'org_admin' };
  const scopeB = { membershipId: 'membership-b', customerOrganizationId: orgB,
    organizationName: 'Synthetic B', role: 'viewer' };
  const repo = {
    findActiveScope: async (actor, membership) => {
      if (actor === 'customer-a' && membership === 'membership-a') return scopeA;
      if (actor === 'customer-b' && membership === 'membership-b') return scopeB;
      return null;
    },
    findActiveDnsFilterOrganization: async (id) => id === orgA ? '900001' : id === orgB ? '900002' : null,
    listManagedOrganizations: async () => [
      { id: orgA, organizationName: 'Synthetic A', status: 'active', mappingStatus: 'active', dnsfilterOrganizationId: '900001' },
      { id: orgB, organizationName: 'Synthetic B', status: 'active', mappingStatus: 'active', dnsfilterOrganizationId: '900002' },
    ],
    hasActiveMspAdminGrant: async (actor) => actor === 'msp-admin',
    getLicenseAlertState: async (id) => id === orgA ? {
      organizationId: orgA, organizationName: 'Synthetic A', dnsfilterOrganizationId: '900001',
      allocatedLicenses: 2, licenseSnapshotUpdatedAt: observedAt,
    } : null,
    claimLicenseAlert: async () => { calls.claims++; throw Error('manual claim forbidden in dedicated mode'); },
    clearResolvedLicenseAlert: async () => { calls.claims++; throw Error('manual clear forbidden in dedicated mode'); },
    updateLicenseAllocation: async (actor, id, count) => {
      calls.allocation.push([actor, id, count]);
      return { allocatedLicenses: count, licenseSnapshotUpdatedAt: observedAt };
    },
  };
  const identityService = {
    verifySession: (token) => {
      if (!['customer-a', 'customer-b', 'msp-admin'].includes(token)) throw Error('invalid');
      return { userId: token, sessionVersion: 1 };
    },
    verifyActiveSession: async ({ userId }) => ({ id: userId, status: 'active', sessionVersion: 1 }),
  };
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/secure-guard', createSecureGuardRouter({
    identityService, repo,
    inventoryClient: { getInventory: async (id) => {
      calls.inventory.push(id);
      return id === '900001' ? inventory : id === '900002' ? inventoryB : null;
    } },
    roamingUsageClient: { getRoamingUsage: async (id) => {
      calls.officialUsage.push(id);
      return { roamingClientsInUse: 3, dnsfilterAllocatedRoamingClients: 2,
        retrievedAt: observedAt, from: '2026-11-11', to: '2026-11-18' };
    } },
    managementClient: {
      getOrganizationLicenseUsage: async (id) => {
        assert.equal(id, '900001');
        return { usage: 3, checkedAt: observedAt };
      },
      createOrganization: async () => { calls.dnsfilterWrites++; throw Error('forbidden'); },
      createNetwork: async () => { calls.dnsfilterWrites++; throw Error('forbidden'); },
    },
    overageStore: {
      listOpen: async () => [alert],
      markInProgress: async (actor, id, responseChoice, responseNote) => {
        calls.handling.push([actor, id, responseChoice, responseNote]);
        alert.status = 'in_progress';
        return true;
      },
    },
    mailer: { sendSecureGuardInvitationEmail: async () => { calls.email++; throw Error('forbidden'); } },
    licenseAlertSlack: { isConfigured: () => true, send: async () => { calls.slack++; throw Error('forbidden'); } },
    manualLicenseAlertDeliveryEnabled: false,
    agentUninstallEnabled: false,
    agentUninstallClient: { isConfigured: () => true, requestQueuedUninstall: async () => {
      calls.agentUninstall++; throw Error('forbidden');
    } },
    portalBaseUrl: 'https://portal.example.test',
  }));

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/secure-guard`;
  const customerHeaders = { Cookie: 'secure_guard_session=customer-a', 'X-Secure-Guard-Membership': 'membership-a' };
  const mspHeaders = { Cookie: 'secure_guard_session=msp-admin' };
  try {
    assert.equal((await fetch(`${base}/overview`)).status, 401);
    assert.equal((await fetch(`${base}/overview`, {
      headers: { ...customerHeaders, 'X-Secure-Guard-Membership': 'membership-b' },
    })).status, 403);
    assert.equal((await fetch(`${base}/overview`, {
      headers: { ...mspHeaders, 'X-Secure-Guard-Membership': 'membership-a' },
    })).status, 403);

    const customerB = await fetch(`${base}/overview`, {
      headers: { Cookie: 'secure_guard_session=customer-b', 'X-Secure-Guard-Membership': 'membership-b' },
    });
    assert.equal(customerB.status, 200);
    const customerBBody = await customerB.json();
    assert.equal(customerBBody.organization.name, 'Synthetic B');
    assert.deepEqual(customerBBody.agents, []);

    const overview = await fetch(`${base}/overview`, { headers: customerHeaders });
    assert.equal(overview.status, 200);
    const customerBody = await overview.json();
    assert.equal(customerBody.organization.name, 'Synthetic A');
    assert.equal(customerBody.capabilities.agentQueuedUninstall, false);
    assert.deepEqual(customerBody.agents, inventory.agents);
    assert.deepEqual(calls.inventory, ['900002', '900001']);

    const uninstall = await fetch(`${base}/agents/${agentId}/queued-uninstall`, {
      method: 'POST', headers: { ...customerHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId: '201', hostname: 'synthetic-a-pc', confirmHostname: 'synthetic-a-pc', acknowledgeCommunicationRisk: true }),
    });
    assert.equal(uninstall.status, 503);
    assert.deepEqual(await uninstall.json(), { error: 'AGENT_UNINSTALL_NOT_ENABLED' });

    assert.equal((await fetch(`${base}/admin/overage-alerts`, { headers: customerHeaders })).status, 403);
    const officialUsage = await fetch(`${base}/admin/organizations/${orgA}/roaming-license-usage`, { headers: mspHeaders });
    assert.equal(officialUsage.status, 200);
    assert.deepEqual(((await officialUsage.json())), {
      organizationId: orgA, source: 'dnsfilter.organization_usage_detailed',
      allocated: 2, usage: 3, status: 'overage', overBy: 1,
      observedAt, periodFrom: '2026-11-11', periodTo: '2026-11-18',
    });
    const alerts = await fetch(`${base}/admin/overage-alerts`, { headers: mspHeaders });
    assert.equal(alerts.status, 200);
    assert.equal((await alerts.json()).alerts[0].status, 'open');
    const handled = await fetch(`${base}/admin/overage-alerts/12/handling`, {
      method: 'PATCH', headers: { ...mspHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ responseChoice: 'reduce_clients', responseNote: 'Synthetic follow-up' }),
    });
    assert.equal(handled.status, 204);
    assert.equal(alert.status, 'in_progress');
    const manual = await fetch(`${base}/admin/organizations/${orgA}/license-alerts/check`, {
      method: 'POST', headers: mspHeaders,
    });
    assert.equal(manual.status, 200);
    assert.equal((await manual.json()).notification, 'managed_by_scheduled_monitor');
    const allocation = await fetch(`${base}/admin/organizations/${orgA}/license-allocation`, {
      method: 'PATCH', headers: { ...mspHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ allocatedLicenses: 4 }),
    });
    assert.equal(allocation.status, 200);
    assert.equal((await allocation.json()).allocation.source, 'dnsfilter_console_snapshot');

    assert.deepEqual(calls.officialUsage, ['900001']);
    assert.deepEqual(calls.handling, [['msp-admin', '12', 'reduce_clients', 'Synthetic follow-up']]);
    assert.deepEqual(calls.allocation, [['msp-admin', orgA, 4]]);
    for (const key of ['agentUninstall', 'claims', 'slack', 'email', 'dnsfilterWrites']) assert.equal(calls[key], 0, key);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
