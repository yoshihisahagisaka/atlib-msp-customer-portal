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
