const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { SecureGuardIdentityService } = require('../dist/services/secureGuardIdentityService');

const mfaKeys = {
  SECURE_GUARD_MFA_ENCRYPTION_KEY_V1: Buffer.alloc(32, 17).toString('base64'),
  SECURE_GUARD_MFA_OTP_PEPPER: Buffer.alloc(32, 29).toString('base64'),
};

test('password-only login returns a challenge and never issues a standard JWT', async () => {
  const hash = await bcrypt.hash('correct-password', 12);
  const active = { id: 'user-1', email: 'person@example.test', passwordHash: hash, status: 'active', sessionVersion: 1 };
  let issued;
  const repo = {
    findUserByEmail: async () => active,
    findUserById: async () => active,
    mfaGetSetting: async () => ({ method: 'totp', state: 'active' }),
    mfaIssueChallenge: async (data) => { issued = data; return true; },
  };
  const service = new SecureGuardIdentityService(repo, 'test-secret', '1h', undefined, mfaKeys);
  const response = await service.login(active.email, 'correct-password');
  assert.equal(response.flow, 'MFA_REQUIRED');
  assert.equal(response.method, 'totp');
  assert.match(response.challengeToken, /^[a-f0-9]{64}$/);
  assert.match(issued.tokenHash, /^[a-f0-9]{64}$/);
  assert.notEqual(response.challengeToken, issued.tokenHash);
  assert.equal(await service.login(active.email, 'wrong-password'), null);

  const disabled = { ...active, status: 'disabled' };
  const disabledService = new SecureGuardIdentityService({
    ...repo, findUserByEmail: async () => disabled,
  }, 'test-secret', '1h', undefined, mfaKeys);
  assert.equal(await disabledService.login(active.email, 'correct-password'), null);
});

test('MFA unregistered login must begin enrolment without a normal JWT', async () => {
  const hash = await bcrypt.hash('correct-password', 4);
  const user = { id: 'user-2', email: 'new@example.test', passwordHash: hash, status: 'active', sessionVersion: 1 };
  const service = new SecureGuardIdentityService({
    findUserByEmail: async () => user,
    mfaGetSetting: async () => null,
    mfaIssueChallenge: async (value) => {
      assert.equal(value.purpose, 'enroll');
      assert.equal(value.method, null);
      return true;
    },
  }, 'test-secret', '1h', undefined, mfaKeys);
  const result = await service.login(user.email, 'correct-password');
  assert.equal(result.flow, 'MFA_ENROLLMENT_REQUIRED');
  assert.match(result.challengeToken, /^[a-f0-9]{64}$/);
});

test('old JWT without MFA claims is rejected and a stale or reset-required session fails closed', async () => {
  const user = { id: 'user-1', email: 'person@example.test', passwordHash: 'x', status: 'active', sessionVersion: 2 };
  let state = 'active';
  const repo = {
    findUserById: async () => user,
    mfaGetSetting: async () => ({ method: 'totp', state }),
  };
  const service = new SecureGuardIdentityService(repo, 'test-secret', '1h', undefined, mfaKeys);
  const oldToken = jwt.sign({ userId: user.id, sessionVersion: user.sessionVersion }, 'test-secret');
  assert.throws(() => service.verifySession(oldToken), /MFA_SESSION_REQUIRED/);
  const token = jwt.sign({
    userId: user.id, sessionVersion: user.sessionVersion, mfaVerified: true, mfaMethod: 'totp',
  }, 'test-secret');
  const verified = service.verifySession(token);
  assert.equal((await service.verifyActiveSession(verified)).id, user.id);
  assert.equal(await service.verifyActiveSession({ ...verified, sessionVersion: 1 }), null);
  state = 'reset_required';
  assert.equal(await service.verifyActiveSession(verified), null);
});

test('invitation persistence receives a hash, never the raw token', async () => {
  let received;
  const repo = { createInvitation: async (input) => { received = input; } };
  const service = new SecureGuardIdentityService(repo, 'test-secret', '1h');
  const invitation = await service.createInvitation({
    email: 'person@example.test', customerOrganizationId: 'org-1',
    role: 'viewer', invitedByUserId: 'admin-1',
  });
  assert.notEqual(received.tokenHash, invitation.token);
  assert.match(received.tokenHash, /^[a-f0-9]{64}$/);
});
