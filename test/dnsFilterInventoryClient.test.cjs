const test = require('node:test');
const assert = require('node:assert/strict');
const { DnsFilterInventoryClient, DnsFilterInventoryError } = require('../dist/services/dnsFilterInventoryClient');

const organizationId = '2001';
const site = (id, name) => ({ id, attributes: { name }, relationships: { organization: { data: { id: organizationId } } } });
const agent = (id, hostname, network) => ({ id, attributes: { hostname, status: 'active', agent_state: 'protected' }, relationships: { organization: { data: { id: organizationId } }, network: { data: { id: network } } } });
const page = (data, next = null, meta = {}) => ({ data, links: { next }, meta });

function fetchFrom(responses) {
  const calls = [];
  return {
    calls,
    fetcher: async (url, init) => {
      calls.push({ url, init });
      const body = responses[url];
      if (!body) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => body };
    },
  };
}

test('reads multiple Sites and Agents with only the PoC GET paths, then reconciles the two Agent collections', async () => {
  const root = 'https://api.dnsfilter.com';
  const fixture = fetchFrom({
    [`${root}/v1/networks?organization_id=${organizationId}`]: page([site('site-a', 'Tokyo'), site('site-b', 'Osaka')]),
    [`${root}/v1/user_agents?organization_ids=${organizationId}&network_ids=site-a`]: page([agent('agent-a', 'pc-a', 'site-a')]),
    [`${root}/v1/user_agents?organization_ids=${organizationId}&network_ids=site-b`]: page([]),
    [`${root}/v1/user_agents?organization_ids=${organizationId}`]: page([agent('agent-a', 'pc-a', 'site-a')]),
  });
  const inventory = await new DnsFilterInventoryClient('not-disclosed', fixture.fetcher).getInventory(organizationId);
  assert.deepEqual(inventory.sites, [{ id: 'site-b', name: 'Osaka', agentCount: 0, policy: null }, { id: 'site-a', name: 'Tokyo', agentCount: 1, policy: null }]);
  assert.deepEqual(inventory.agents, [{ id: 'agent-a', hostname: 'pc-a', siteId: 'site-a', status: 'active', agentState: 'protected' }]);
  assert.equal(fixture.calls.length, 4);
  assert.ok(fixture.calls.every((call) => call.init.method === 'GET'));
  assert.ok(fixture.calls.every((call) => call.url.startsWith(root)));
  assert.ok(fixture.calls.every((call) => !call.url.includes('not-disclosed')));
});

test('follows a permitted Network pagination link and rejects mixed total_count pagination evidence', async () => {
  const root = 'https://api.dnsfilter.com';
  const next = `${root}/v1/networks?organization_id=${organizationId}&page=2`;
  const fixture = fetchFrom({
    [`${root}/v1/networks?organization_id=${organizationId}`]: page([site('site-a', 'Tokyo')], next),
    [next]: page([site('site-b', 'Osaka')], null, { total_count: 2 }),
  });
  await assert.rejects(() => new DnsFilterInventoryClient('key', fixture.fetcher).getInventory(organizationId), DnsFilterInventoryError);
});

test('rejects another customer record, an API failure, and unmatched organization-wide Agents', async () => {
  const root = 'https://api.dnsfilter.com';
  const foreignSite = site('site-a', 'Tokyo');
  foreignSite.relationships.organization.data.id = 'other';
  const cases = [
    fetchFrom({ [`${root}/v1/networks?organization_id=${organizationId}`]: page([foreignSite]) }),
    fetchFrom({}),
    fetchFrom({
      [`${root}/v1/networks?organization_id=${organizationId}`]: page([site('site-a', 'Tokyo')]),
      [`${root}/v1/user_agents?organization_ids=${organizationId}&network_ids=site-a`]: page([]),
      [`${root}/v1/user_agents?organization_ids=${organizationId}`]: page([agent('agent-a', 'pc-a', 'site-a')]),
    }),
  ];
  for (const fixture of cases) {
    await assert.rejects(() => new DnsFilterInventoryClient('key', fixture.fetcher).getInventory(organizationId), DnsFilterInventoryError);
  }
});

test('aborts a delayed DNSFilter GET once and reports no inventory instead of retrying', async () => {
  let calls = 0;
  let aborts = 0;
  const delayedFetcher = async (_url, init) => new Promise((_resolve, reject) => {
    calls += 1;
    init.signal.addEventListener('abort', () => { aborts += 1; reject(new Error('aborted')); }, { once: true });
  });
  await assert.rejects(() => new DnsFilterInventoryClient('key', delayedFetcher, 1).getInventory(organizationId), DnsFilterInventoryError);
  assert.equal(calls, 1);
  assert.equal(aborts, 1);
});
