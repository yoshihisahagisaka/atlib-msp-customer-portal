const test = require('node:test');
const assert = require('node:assert/strict');
const { DnsFilterManagementClient, DnsFilterManagementError } = require('../dist/services/dnsFilterManagementClient');

test('creates an Organization only with the configured MSP identifier and validates the returned parent', async () => {
  let request; const client = new DnsFilterManagementClient('project', '11473', async () => 'secret', async (url, init) => { request = { url, init }; return { ok: true, json: async () => ({ data: { id: '2001', attributes: { name: 'Example', managed_by_msp_id: '11473' } } }) }; });
  assert.deepEqual(await client.createOrganization('Example'), { id: '2001', name: 'Example' });
  assert.equal(request.url, 'https://api.dnsfilter.com/v1/organizations'); assert.equal(request.init.method, 'POST'); assert.deepEqual(JSON.parse(request.init.body).organization, { name: 'Example', managed_by_msp_id: 11473 }); assert.equal(request.url.includes('secret') || request.init.body.includes('secret'), false);
});
test('refuses importing an Organization outside the configured MSP', async () => {
  const client = new DnsFilterManagementClient('project', '11473', async () => 'secret', async () => ({ ok: true, json: async () => ({ data: { id: '2001', attributes: { name: 'Example', managed_by_msp_id: 'other' } } }) }));
  await assert.rejects(() => client.getOrganization('2001'), DnsFilterManagementError);
});
test('lists only MSP-managed customer Organizations, excludes the MSP root, and follows a safe next page', async () => {
  const requests = []; const pages = [
    { data: [{ id: '1000', attributes: { name: 'MSP root' } }, { id: '2001', attributes: { name: 'Customer one', managed_by_msp_id: '11473' } }], links: { next: '/v1/organizations?page=2' } },
    { data: [{ id: '2002', attributes: { name: 'Customer two', managed_by_msp_id: 11473 } }], links: { next: null } },
  ];
  const client = new DnsFilterManagementClient('project', '11473', async () => 'secret', async (url) => { requests.push(url); return { ok: true, json: async () => pages.shift() }; });
  assert.deepEqual(await client.listOrganizations(), [{ id: '2001', name: 'Customer one' }, { id: '2002', name: 'Customer two' }]);
  assert.equal(requests.length, 2);
});
test('rejects a listed Organization managed by a different MSP', async () => {
  const client = new DnsFilterManagementClient('project', '11473', async () => 'secret', async () => ({ ok: true, json: async () => ({ data: [{ id: '2001', attributes: { name: 'Other', managed_by_msp_id: '99999' } }], links: { next: null } }) }));
  await assert.rejects(() => client.listOrganizations(), DnsFilterManagementError);
});

test('uses only the verified roaming_client_count for license usage', async () => {
  const client = new DnsFilterManagementClient('project', '11473', async () => 'secret', async () => ({ ok: true, json: async () => ({ data: { organization_id: '10222523', roaming_client_count: 3, user_count: 99 } }) }));
  const result = await client.getOrganizationLicenseUsage('10222523');
  assert.equal(result.usage, 3);
  assert.match(result.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('keeps license usage UNKNOWN when the verified field is absent', async () => {
  const client = new DnsFilterManagementClient('project', '11473', async () => 'secret', async () => ({ ok: true, json: async () => ({ data: { organization_id: '10222523', user_count: 1 } }) }));
  assert.equal((await client.getOrganizationLicenseUsage('10222523')).usage, null);
});

test('rejects invalid license usage instead of counting Agent records', async () => {
  const client = new DnsFilterManagementClient('project', '11473', async () => 'secret', async () => ({ ok: true, json: async () => ({ data: { organization_id: '10222523', roaming_client_count: '3', agents: [{}, {}, {}] } }) }));
  await assert.rejects(() => client.getOrganizationLicenseUsage('10222523'), DnsFilterManagementError);
});

test('creates a Site with fixed Policy, Block Page, external ID and verifies GET without leaking its secret key', async () => {
  const calls = [];
  const input = { name: 'Secure Guard Trial Site', policyIds: ['301'], blockPageId: '402', externalId: 'sg-trial-10222523-1' };
  const client = new DnsFilterManagementClient('project', '11473', async () => 'secret', async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    if (init.method === 'POST') return { ok: true, json: async () => ({ data: { id: '501', attributes: { name: input.name } } }) };
    return { ok: true, json: async () => ({ data: {
      id: '501', attributes: { name: input.name, block_page_id: 402, external_id: input.externalId, secret_key: 'never-expose' },
      relationships: { organization: { data: { id: '10222523' } }, policies: { data: [{ id: '301' }] } },
    } }) };
  });
  const result = await client.createNetwork('10222523', input);
  assert.deepEqual(result, { id: '501', name: input.name });
  assert.equal(JSON.stringify(result).includes('never-expose'), false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://api.dnsfilter.com/v1/networks');
  assert.deepEqual(JSON.parse(calls[0].body).network, {
    name: input.name, organization_id: 10222523, policy_ids: [301], block_page_id: 402, external_id: input.externalId,
  });
  assert.equal(calls[1].method, 'GET');
  assert.equal(calls[1].url, 'https://api.dnsfilter.com/v1/networks/501');
});

test('never re-POSTs when Site read-back is missing or owned by another Organization', async () => {
  for (const readBack of [null, {
    data: { id: '501', attributes: { name: 'Trial Site', block_page_id: 402, external_id: 'sg-1' },
      relationships: { organization: { data: { id: '999' } }, policies: { data: [{ id: '301' }] } } },
  }]) {
    let postCount = 0;
    const client = new DnsFilterManagementClient('project', '11473', async () => 'secret', async (_url, init) => {
      if (init.method === 'POST') { postCount++; return { ok: true, json: async () => ({ data: { id: '501' } }) }; }
      return readBack ? { ok: true, json: async () => readBack } : { ok: false, status: 503 };
    });
    await assert.rejects(() => client.createNetwork('10222523', { name: 'Trial Site', policyIds: ['301'], blockPageId: '402', externalId: 'sg-1' }),
      (error) => error instanceof DnsFilterManagementError && error.code === 'DNSFILTER_CREATE_OUTCOME_UNKNOWN');
    assert.equal(postCount, 1);
  }
});
