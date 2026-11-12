const test = require('node:test');
const assert = require('node:assert/strict');
const { SecureGuardRepo } = require('../dist/services/secureGuardRepo');

test('an active membership resolves its Secure Guard organization name without a Zabbix customer join', async () => {
  const pool = {
    query: async (sql, params) => {
      assert.equal(params[0], 'member-1');
      assert.equal(params[1], 'user-1');
      assert.match(sql, /o\.organization_name/);
      assert.doesNotMatch(sql, /JOIN customers/);
      return { rows: [{ membership_id: 'member-1', customer_organization_id: 'org-1', organization_name: 'Secure Guard Only', role: 'viewer' }] };
    },
  };
  const repo = new SecureGuardRepo(pool);
  const scope = await repo.findActiveScope('user-1', 'member-1');
  assert.deepEqual(scope, {
    membershipId: 'member-1',
    customerOrganizationId: 'org-1',
    organizationName: 'Secure Guard Only',
    role: 'viewer',
  });
});

test('an inactive Secure Guard organization remains denied before DNSFilter mapping resolution', async () => {
  const repo = new SecureGuardRepo({ query: async () => ({ rows: [] }) });
  assert.equal(await repo.findActiveScope('user-1', 'member-1'), null);
  assert.equal(await repo.findActiveDnsFilterOrganization('org-1'), null);
});

test('migration 012 is ordered after 011 and preserves the tenant identity tables', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(root).filter((file) => file.endsWith('.sql')).sort();
  assert.ok(files.indexOf('011_secure_guard_identity_scope.sql') < files.indexOf('012_secure_guard_organization_independence.sql'));
  const migration = fs.readFileSync(path.join(root, '012_secure_guard_organization_independence.sql'), 'utf8');
  assert.match(migration, /ALTER TABLE customer_organizations/);
  assert.doesNotMatch(migration, /portal_users|customer_memberships|msp_role_grants|dnsfilter_organization_mappings|secure_guard_receipts|secure_guard_audit_events/);
});
