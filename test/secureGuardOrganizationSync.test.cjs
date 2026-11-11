const test = require('node:test');
const assert = require('node:assert/strict');
const { synchronizeManagedOrganizations } = require('../dist/services/secureGuardOrganizationSync');

function fixture(initial = []) {
  const rows = [...initial]; const audit = []; const creations = [];
  const repo = {
    async listManagedOrganizations() { return rows.map((r) => ({ ...r })); },
    async createManagedOrganization(actor, name, externalId) {
      creations.push({ actor, name, externalId });
      await Promise.resolve(); // Allow two syncs to race at the DB UNIQUE constraint.
      if (rows.some((r) => r.dnsfilterOrganizationId === externalId)) throw { code: '23505' };
      const row = { id: `local-${rows.length + 1}`, organizationName: name, status: 'active', dnsfilterOrganizationId: externalId, mappingStatus: 'active' };
      rows.push(row);
      return { ...row };
    },
    async recordSystemAudit(actor, action, result) { audit.push({ actor, action, result }); },
  };
  return { repo, rows, audit, creations };
}

test('MSP sync imports only unmapped children, preserves the parent exclusion, and is idempotent on F5', async () => {
  const f = fixture([{ id: 'existing', organizationName: 'Existing', status: 'active', dnsfilterOrganizationId: '2001', mappingStatus: 'active' }]);
  const upstream = [{ id: '2001', name: 'Existing' }, { id: '2002', name: 'New Customer' }];
  const first = await synchronizeManagedOrganizations(f.repo, 'actor-1', upstream);
  assert.deepEqual([first.sync.imported, first.sync.skipped, first.sync.failed, first.sync.needsReview], [1, 1, 0, 0]);
  assert.deepEqual(f.creations, [{ actor: 'actor-1', name: 'New Customer', externalId: '2002' }]);
  const second = await synchronizeManagedOrganizations(f.repo, 'actor-1', upstream);
  assert.deepEqual([second.sync.imported, second.sync.skipped], [0, 2]);
  assert.equal(f.rows.length, 2);
});

test('concurrent syncs resolve an exact active unique-key conflict as a skip, never duplicating a mapping', async () => {
  const f = fixture(); const upstream = [{ id: '2002', name: 'New Customer' }];
  const [a, b] = await Promise.all([synchronizeManagedOrganizations(f.repo, 'actor-1', upstream), synchronizeManagedOrganizations(f.repo, 'actor-2', upstream)]);
  assert.equal(a.sync.imported + b.sync.imported, 1);
  assert.equal(a.sync.skipped + b.sync.skipped, 1);
  assert.equal(f.rows.length, 1);
});

test('disabled and suspended links, unlinked same-name drafts, and stale local links are review-only', async () => {
  const f = fixture([
    { id: 'one', organizationName: 'Disabled', status: 'active', dnsfilterOrganizationId: '2001', mappingStatus: 'disabled' },
    { id: 'two', organizationName: 'Suspended', status: 'suspended', dnsfilterOrganizationId: '2002', mappingStatus: 'active' },
    { id: 'three', organizationName: 'Draft', status: 'suspended', dnsfilterOrganizationId: null, mappingStatus: null },
    { id: 'four', organizationName: 'Missing upstream', status: 'active', dnsfilterOrganizationId: '9999', mappingStatus: 'active' },
  ]);
  const result = await synchronizeManagedOrganizations(f.repo, 'actor', [
    { id: '2001', name: 'Disabled' }, { id: '2002', name: 'Suspended' }, { id: '2003', name: 'Draft' },
  ]);
  assert.deepEqual([result.sync.imported, result.sync.skipped, result.sync.failed, result.sync.needsReview], [0, 0, 0, 4]);
  assert.equal(f.creations.length, 0);
  assert.deepEqual(result.sync.issues.map((issue) => issue.code), [
    'LOCAL_MAPPING_REQUIRES_REVIEW', 'LOCAL_MAPPING_REQUIRES_REVIEW', 'LOCAL_UNMAPPED_SAME_NAME', 'LOCAL_MAPPING_NOT_IN_DNSFILTER',
  ]);
});

test('a failed import does not roll back earlier successes or retry the failed Organization', async () => {
  const f = fixture();
  const create = f.repo.createManagedOrganization;
  f.repo.createManagedOrganization = (actor, name, id) => id === '2002' ? Promise.reject(new Error('database unavailable')) : create(actor, name, id);
  const result = await synchronizeManagedOrganizations(f.repo, 'actor', [{ id: '2001', name: 'One' }, { id: '2002', name: 'Two' }]);
  assert.deepEqual([result.sync.imported, result.sync.failed], [1, 1]);
  assert.equal(f.rows.length, 1);
  assert.deepEqual(f.audit.map((item) => item.action), ['organization.sync.import.failed']);
});

test('MSP admin screen syncs on load/F5 without manual imports, arbitrary Policy selection or Organization ID entry', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'secure-guard-admin.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'secureGuardAdmin.js'), 'utf8');
  assert.match(html, /secureGuardAdmin\.js/);
  assert.match(script, /sgSynchronize\(\);/);
  assert.match(script, /\/dnsfilter\/organizations\/sync/);
  assert.match(script, /customerOrganizationId: org\.id/);
  assert.doesNotMatch(html, /organization-import-form|site-policy|import-dnsfilter-organization-id|initial-organization-id|site-form/);
  assert.doesNotMatch(script, /setInterval|setTimeout|\/dnsfilter\/organizations\/import/);
});
