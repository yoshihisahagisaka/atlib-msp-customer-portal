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

test('migration 012 makes Secure Guard organizations independent without changing Zabbix customers', () => {
  const migration = read('migrations/012_secure_guard_organization_independence.sql');
  assert.match(migration, /ADD COLUMN organization_name VARCHAR\(255\)/);
  assert.match(migration, /SET organization_name = c\.company_name/);
  assert.match(migration, /ALTER COLUMN customer_id DROP NOT NULL/);
  assert.match(migration, /DROP CONSTRAINT customer_organizations_customer_id_fkey/);
  assert.doesNotMatch(migration, /ALTER TABLE customers|DROP TABLE|DELETE FROM/);
});

test('Secure Guard scope resolution does not require a Zabbix customer record', () => {
  const repo = read('src/services/secureGuardRepo.ts');
  const scopeMethods = repo.slice(repo.indexOf('async listActiveMemberships'), repo.indexOf('async hasActiveMspAdminGrant'));
  assert.match(scopeMethods, /o\.organization_name/);
  assert.doesNotMatch(scopeMethods, /JOIN customers/);
});

test('Secure Guard login applies both IP and account rate-limit gates', () => {
  const route = read('src/routes/secureGuardAuth.ts');
  assert.match(route, /secureGuardLoginIpRateLimiter, checkLoginRateLimitFor\(secureGuardLoginRateLimiter\)/);
});
