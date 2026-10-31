const test = require('node:test');
const assert = require('node:assert/strict');
const { requireSecureGuardCustomerScope, requireMspAdmin } = require('../dist/middleware/secureGuardAuth');

function response() {
  return { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
}

test('customer scope is accepted only when the membership belongs to the authenticated individual', async () => {
  const scope = { membershipId: 'membership-1', customerOrganizationId: 'org-1', organizationName: 'Example', role: 'viewer' };
  const repo = { findActiveScope: async (userId, membershipId) => userId === 'user-1' && membershipId === 'membership-1' ? scope : null };
  const gate = requireSecureGuardCustomerScope(repo);
  const req = { secureGuardUserId: 'user-1', header: () => 'membership-1' };
  let next = false;
  await gate(req, response(), () => { next = true; });
  assert.equal(next, true);
  assert.equal(req.secureGuardScope.customerOrganizationId, 'org-1');
});

test('cross-organization or forged membership selection is denied on the server', async () => {
  const repo = { findActiveScope: async () => null };
  const gate = requireSecureGuardCustomerScope(repo);
  const res = response();
  await gate({ secureGuardUserId: 'user-1', header: () => 'other-membership' }, res, () => assert.fail('must not continue'));
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'CUSTOMER_SCOPE_DENIED' });
});

test('an MSP grant is never inferred from customer membership', async () => {
  const gate = requireMspAdmin({ hasActiveMspAdminGrant: async () => false });
  const res = response();
  await gate({ secureGuardUserId: 'user-1' }, res, () => assert.fail('must not continue'));
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'MSP_SCOPE_DENIED' });
});
