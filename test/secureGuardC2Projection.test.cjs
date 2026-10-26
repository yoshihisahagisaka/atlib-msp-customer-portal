const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyAndProjectC2Receipt, C2ProjectionVerificationError } = require('../dist/services/secureGuardC2Projection');

function candidate(organizationId = '10220954') {
  const payload = {
    source_sha: '230865cf4649228872ff81aad27cfd90c0884020',
    mode: 'DryRun',
    inventory: {
      organization_id: organizationId,
      msp_parent_id: '11473',
      sites: [
        { id: 'internal-site-1', name: 'Customer confidential site', organization_id: organizationId },
        { id: 'internal-site-2', name: 'Another confidential site', organization_id: organizationId },
      ],
      agents: [{ uuid: 'agent-secret-uuid', hostname: 'sensitive-hostname', organization_id: organizationId, site_id: 'internal-site-1', status: 'active', agent_state: 'protected' }],
      paging: {
        site_pages: 1,
        site_total: 2,
        org_agent_pages: 1,
        org_agent_total: 1,
        per_site: [
          { scope: 'site', site_id: 'internal-site-1', pages: 1, total: 1, proof: 'explicit-next-null+unique-ids' },
          { scope: 'site', site_id: 'internal-site-2', pages: 1, total: 0, proof: 'explicit-next-null+unique-ids' },
        ],
      },
      visibility: 'API default documented collection only; relay/deleted visibility requires review',
    },
    mutations_enabled: false,
  };
  const planHash = crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
  return {
    plan: { plan_hash: planHash, payload },
    gcsObject: `gs://audit-bucket/dryruns/organizations/${organizationId}/plans/${planHash}.json`,
    generation: '1792936630217425',
    observedAt: '2026-10-25T01:02:03.000Z',
    completedAt: '2026-10-25T01:03:03.000Z',
  };
}

test('C2 projection verifies hash, generation and organization before discarding sensitive plan fields', () => {
  const projection = verifyAndProjectC2Receipt(candidate(), '10220954');
  assert.deepEqual(projection.sites, [{ displayOrder: 1, agentCount: 1 }, { displayOrder: 2, agentCount: 0 }]);
  assert.deepEqual(projection.agents, [{ displayOrder: 1, siteDisplayOrder: 1, status: 'active', agentState: 'protected' }]);
  const rendered = JSON.stringify(projection);
  for (const value of ['internal-site-1', 'Customer confidential site', 'agent-secret-uuid', 'sensitive-hostname', 'audit-bucket']) {
    assert.equal(rendered.includes(value), false);
  }
});

test('C2 projection rejects a customer mapping mismatch rather than projecting another organization', () => {
  assert.throws(() => verifyAndProjectC2Receipt(candidate(), '10220955'), C2ProjectionVerificationError);
});

test('C2 projection rejects a plan changed after its canonical hash was produced', () => {
  const input = candidate();
  input.plan.payload.inventory.agents[0].status = 'unexpected-state';
  assert.throws(() => verifyAndProjectC2Receipt(input, '10220954'), C2ProjectionVerificationError);
});

test('C2 projection rejects an object path that does not bind the hash and organization together', () => {
  const input = candidate();
  input.gcsObject = 'gs://audit-bucket/dryruns/organizations/10220955/plans/other.json';
  assert.throws(() => verifyAndProjectC2Receipt(input, '10220954'), C2ProjectionVerificationError);
});
