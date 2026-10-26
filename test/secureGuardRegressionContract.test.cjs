const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('existing portal and staff session names remain unchanged', () => {
  assert.match(read('src/middleware/auth.ts'), /const COOKIE_NAME = 'portal_session'/);
  assert.match(read('src/middleware/staffAuth.ts'), /const COOKIE_NAME = 'staff_session'/);
  assert.match(read('src/middleware/secureGuardAuth.ts'), /secure_guard_session/);
});

test('existing Zabbix routes remain mounted alongside the Secure Guard routes', () => {
  const server = read('src/server.ts');
  for (const route of ['/api/notifications', '/api/maintenance', '/api/hosts', '/api/topology']) assert.match(server, new RegExp(route));
  assert.match(server, /\/api\/secure-guard/);
});

test('migration is additive and defines the tenant-bound identity tables', () => {
  const migration = read('migrations/011_secure_guard_identity_scope.sql');
  for (const table of ['portal_users', 'customer_organizations', 'customer_memberships', 'msp_role_grants', 'dnsfilter_organization_mappings', 'secure_guard_receipts', 'secure_guard_audit_events']) assert.match(migration, new RegExp(`CREATE TABLE ${table}`));
  assert.doesNotMatch(migration, /DROP TABLE|ALTER TABLE customers/);
});
