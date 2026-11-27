const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const { createHash } = require('node:crypto');
const { createSecureGuardAuthRouter } = require('../dist/routes/secureGuardAuth');
const { createSecureGuardRouter } = require('../dist/routes/secureGuard');

const actorMembership = '00000000-0000-4000-8000-000000000001';
const targetMembership = '00000000-0000-4000-8000-000000000002';
const token = 'a'.repeat(64);
const requestedCookie = 'secure_guard_session=synthetic-valid-mfa-jwt';

function fixture(overrides = {}) {
  const effects = [];
  const identityService = {
    verifySession: (jwt) => {
      if (jwt !== 'synthetic-valid-mfa-jwt') throw new Error('cookie not authenticated');
      return { userId: '00000000-0000-4000-8000-000000000003',
        sessionVersion: 1, mfaVerified: true, mfaMethod: 'totp' };
    },
    verifyActiveSession: async () => ({
      id: '00000000-0000-4000-8000-000000000003', status: 'active', sessionVersion: 1,
    }),
    recoverMfa: async (_token, code) => code === 'b'.repeat(32)
      ? { flow: 'MFA_ENROLLMENT_REQUIRED', challengeToken: 'c'.repeat(64) }
      : null,
    startAdminReauth: async () => ({ challengeToken: 'd'.repeat(64), method: 'totp' }),
    verifyAdminReauth: async (_userId, _token, code) => code === '123456',
    ...overrides.identityService,
  };
  const repo = {
    findActiveScope: async (_userId, memberId) => memberId === actorMembership
      ? { membershipId: actorMembership, role: 'org_admin',
        customerOrganizationId: '00000000-0000-4000-8000-000000000004' }
      : null,
    mfaResetByOrgAdmin: async (args) => {
      effects.push({ type: 'dbCommit', args });
      return { email: 'target@synthetic.invalid' };
    },
    recordSystemAudit: async (_actor, action, result) => {
      effects.push({ type: 'audit', action, result });
    },
    ...overrides.repo,
  };
  const mailer = {
    sendSecureGuardInvitationEmail: async () => {},
    sendSecureGuardMfaResetEmail: async (to) => {
      effects.push({ type: 'notification', to });
    },
    ...overrides.mailer,
  };
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/secure-guard/auth', createSecureGuardAuthRouter(identityService, true));
  app.use('/api/secure-guard', createSecureGuardRouter({
    identityService, repo, mailer, inventoryClient: {}, portalBaseUrl: 'https://example.test',
  }));
  return { app, effects };
}

async function useFixture(input, run) {
  const { app, effects } = fixture(input);
  const listener = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  const base = `http://127.0.0.1:${listener.address().port}`;
  const post = async (path, body, opts = {}) => fetch(base + '/api/secure-guard' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    body: JSON.stringify(body),
  });
  try { await run(post, effects); }
  finally { await new Promise((resolve) => listener.close(resolve)); }
}

test('recovery only returns MFA enrollment challenge, never a normal session Cookie', async () => {
  await useFixture({}, async (post) => {
    const result = await post('/auth/mfa/recovery', {
      challengeToken: token, backupCode: 'b'.repeat(32),
    });
    assert.equal(result.status, 202);
    assert.equal((await result.json()).flow, 'MFA_ENROLLMENT_REQUIRED');
    assert.doesNotMatch(result.headers.get('set-cookie') || '', /secure_guard_session=[^;\s]+/);
    const denied = await post('/auth/mfa/recovery', {
      challengeToken: token, backupCode: '0'.repeat(32),
    });
    assert.equal(denied.status, 401);
    const invalid = await post('/auth/mfa/recovery', { challengeToken: token, backupCode: 'xx' });
    assert.equal(invalid.status, 400);
  });
});

test('admin reauth requires MFA Cookie; success is a proof, never an additional session', async () => {
  await useFixture({}, async (post) => {
    assert.equal((await post('/auth/mfa/reauth/start', {})).status, 401);
    const headers = { Cookie: requestedCookie };
    const start = await post('/auth/mfa/reauth/start', {}, { headers });
    assert.equal(start.status, 202);
    assert.equal((await start.json()).method, 'totp');
    assert.doesNotMatch(start.headers.get('set-cookie') || '', /secure_guard_session=[^;\s]+/);
    const verify = await post('/auth/mfa/reauth/verify', {
      challengeToken: 'd'.repeat(64), code: '123456',
    }, { headers });
    assert.equal(verify.status, 204);
    assert.doesNotMatch(verify.headers.get('set-cookie') || '', /secure_guard_session=[^;\s]+/);
    const wrong = await post('/auth/mfa/reauth/verify', {
      challengeToken: 'd'.repeat(64), code: '000000',
    }, { headers });
    assert.equal(wrong.status, 403);
  });
});

test('org_admin reset uses scoped membership and proof; mail follows atomic DB commit', async () => {
  await useFixture({}, async (post, effects) => {
    const resetPath = `/memberships/${targetMembership}/mfa/reset`;
    const body = { reauthChallengeToken: token };
    assert.equal((await post(resetPath, body)).status, 401);
    const headers = { Cookie: requestedCookie, 'X-Secure-Guard-Membership': actorMembership };
    const result = await post(resetPath, body, { headers });
    assert.equal(result.status, 204);
    assert.deepEqual(effects.map(x=>x.type), ['dbCommit', 'notification']);
    assert.deepEqual(effects[0].args, {
      actorUserId: '00000000-0000-4000-8000-000000000003',
      actorSessionVersion: 1, actorMembershipId: actorMembership,
      targetMembershipId: targetMembership,
      reauthTokenHash: createHash('sha256').update(token).digest('hex'),
    });
    assert.equal(effects[1].to, 'target@synthetic.invalid');
    assert.equal((await post(resetPath, { reauthChallengeToken: 'bad' }, { headers })).status, 400);
    assert.equal(effects.length, 2);
  });
});

test('viewer denial, missing reset mailer, and unknown delivery never retry committed reset', async () => {
  const headers = { Cookie: requestedCookie, 'X-Secure-Guard-Membership': actorMembership };
  const path = `/memberships/${targetMembership}/mfa/reset`;
  await useFixture({
    repo: { findActiveScope: async () => ({ membershipId: actorMembership,
      customerOrganizationId: '00000000-0000-4000-8000-000000000004', role: 'viewer' }) },
  }, async (post, effects) => {
    assert.equal((await post(path, { reauthChallengeToken: token }, { headers })).status, 403);
    assert.deepEqual(effects, []);
  });
  await useFixture({
    mailer: { sendSecureGuardMfaResetEmail: undefined },
  }, async (post, effects) => {
    assert.equal((await post(path, { reauthChallengeToken: token }, { headers })).status, 503);
    assert.deepEqual(effects, []);
  });
  await useFixture({
    mailer: { sendSecureGuardMfaResetEmail: async () => { throw new Error('SMTP_UNKNOWN'); } },
  }, async (post, effects) => {
    assert.equal((await post(path, { reauthChallengeToken: token }, { headers })).status, 204);
    assert.deepEqual(effects.map(x=>x.type), ['dbCommit', 'audit']);
    assert.equal(effects[1].action, 'mfa.reset.notification.failed');
  });
});


test('email admin reauthentication requires a delivered OTP and yields a one-use proof', async () => {
  const { SecureGuardIdentityService } = require('../dist/services/secureGuardIdentityService');
  const { SecureGuardMfaCrypto } = require('../dist/services/secureGuardMfa');
  const keys = {
    SECURE_GUARD_MFA_ENCRYPTION_KEY_V1: Buffer.alloc(32, 63).toString('base64'),
    SECURE_GUARD_MFA_OTP_PEPPER: Buffer.alloc(32, 64).toString('base64'),
  };
  const cryptoMfa = new SecureGuardMfaCrypto(keys);
  const user = { id: 'email-admin', email: 'email-admin@fixture.invalid',
    status: 'active', sessionVersion: 1 };
  const factor = { userId: user.id, method: 'email', state: 'active', lastTotpStep: null };
  let challenge = null;
  let delivered = null;
  const repo = {
    findUserById: async () => user,
    mfaHasOrgAdminMembership: async () => true,
    mfaGetSetting: async () => factor,
    mfaIssueChallenge: async (value) => {
      challenge = { ...value, failedAttempts: 0, sendCount: 0, otpHmac: null,
        consumedAt: null, verifiedAt: null, lastSentAt: null };
      return true;
    },
    mfaRecordEmailOtp: async (_userId, tokenHash, mac) => {
      assert.equal(tokenHash, challenge.tokenHash);
      assert.equal(mac, null);
      challenge.sendCount++;
      return { status: 'reserved', sendCount: challenge.sendCount };
    },
    mfaConfirmEmailDelivery: async (_userId, tokenHash, mac, count) => {
      assert.equal(tokenHash, challenge.tokenHash);
      assert.equal(count, 1);
      challenge.otpHmac = mac;
      return true;
    },
    mfaFindChallenge: async (hash) => hash === challenge.tokenHash ? challenge : null,
    mfaVerifyAdminReauth: async (input) => {
      if (challenge.verifiedAt || challenge.consumedAt) return false;
      const result = await input.verify(factor, challenge);
      if (!result.valid) return false;
      challenge.verifiedAt = new Date();
      return true;
    },
  };
  const service = new SecureGuardIdentityService(
    repo, 'synthetic-m3-secret-2026', '1h',
    async (to, otp) => {
      assert.equal(challenge.otpHmac, null, 'OTP must be invalid before delivery acknowledgement');
      delivered = { to, otp };
    }, keys,
  );
  const start = await service.startAdminReauth(user.id);
  assert.equal(start.method, 'email');
  assert.match(start.challengeToken, /^[a-f0-9]{64}$/);
  assert.equal(challenge.purpose, 'admin_reauth');
  assert.ok(challenge.expiresAt.getTime() - Date.now() <= 300000);
  assert.equal(delivered.to, user.email);
  assert.match(challenge.otpHmac, /^[a-f0-9]{64}$/);
  assert.equal(cryptoMfa.matchesEmailOtp(user.id, challenge.tokenHash,
    delivered.otp, challenge.otpHmac), true);
  const wrong = delivered.otp === '123456' ? '654321' : '123456';
  assert.equal(await service.verifyAdminReauth(user.id, start.challengeToken, wrong), false);
  assert.equal(await service.verifyAdminReauth(user.id, start.challengeToken, delivered.otp), true);
  assert.equal(await service.verifyAdminReauth(user.id, start.challengeToken, delivered.otp), false);
});

