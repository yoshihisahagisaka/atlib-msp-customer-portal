const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { SecureGuardIdentityService } = require('../dist/services/secureGuardIdentityService');

test('active personal identity can log in and disabled identity cannot', async () => {
  const hash = await bcrypt.hash('correct-password', 12);
  const active = { id: 'user-1', email: 'person@example.test', passwordHash: hash, status: 'active', sessionVersion: 1 };
  const disabled = { ...active, status: 'disabled' };
  const repo = { findUserByEmail: async () => active, findUserById: async () => active };
  const service = new SecureGuardIdentityService(repo, 'test-secret', '1h');
  assert.ok(await service.login(active.email, 'correct-password'));
  assert.equal(await new SecureGuardIdentityService({ ...repo, findUserByEmail: async () => disabled }, 'test-secret', '1h').login(active.email, 'correct-password'), null);
});

test('a stale Secure Guard session is rejected after session version changes', async () => {
  const repo = { findUserById: async () => ({ id: 'user-1', email: 'person@example.test', passwordHash: 'x', status: 'active', sessionVersion: 2 }) };
  const service = new SecureGuardIdentityService(repo, 'test-secret', '1h');
  assert.equal(await service.verifyActiveSession({ userId: 'user-1', sessionVersion: 1 }), null);
});

test('invitation persistence receives a hash, never the raw token', async () => {
  let received;
  const repo = { createInvitation: async (input) => { received = input; } };
  const service = new SecureGuardIdentityService(repo, 'test-secret', '1h');
  const invitation = await service.createInvitation({ email: 'person@example.test', customerOrganizationId: 'org-1', role: 'viewer', invitedByUserId: 'admin-1' });
  assert.notEqual(received.tokenHash, invitation.token);
  assert.match(received.tokenHash, /^[a-f0-9]{64}$/);
});
