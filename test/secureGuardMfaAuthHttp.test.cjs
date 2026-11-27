const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { SecureGuardIdentityService } = require('../dist/services/secureGuardIdentityService');
const { SecureGuardMfaCrypto, totpAtStep } = require('../dist/services/secureGuardMfa');
const { createSecureGuardAuthRouter } = require('../dist/routes/secureGuardAuth');

const keys = {
  SECURE_GUARD_MFA_ENCRYPTION_KEY_V1: Buffer.alloc(32, 21).toString('base64'),
  SECURE_GUARD_MFA_OTP_PEPPER: Buffer.alloc(32, 22).toString('base64'),
};

function inMemoryRepo(user, initialSetting = null) {
  let setting = initialSetting;
  let challenge = null;
  let hashes = [];
  const fake = {
    findUserByEmail: async (email) => email === user.email ? user : null,
    findUserById: async (id) => id === user.id ? user : null,
    acceptInvitation: async (hash) => hash.length === 64 ? user : null,
    mfaGetSetting: async () => setting,
    mfaIssueChallenge: async (input) => {
      if (challenge) challenge.consumedAt = new Date();
      challenge = { ...input, failedAttempts: 0, sendCount: 0, otpHmac: null,
        lastSentAt: null, consumedAt: null, verifiedAt: null };
      return true;
    },
    mfaFindChallenge: async (hash) => challenge && challenge.tokenHash === hash ? challenge : null,
    mfaStartEnrollment: async (input) => {
      if (!challenge || challenge.tokenHash !== input.tokenHash || challenge.method !== null
        || challenge.purpose !== 'enroll' || (setting && setting.state === 'active')) return false;
      setting = { userId: user.id, method: input.method, state: 'enrolling',
        totpCiphertext: input.totpCiphertext || null, totpNonce: input.totpNonce || null,
        totpTag: input.totpTag || null, keyVersion: input.keyVersion || null,
        lastTotpStep: null };
      challenge.method = input.method;
      return true;
    },
    mfaRecordEmailOtp: async (_userId, hash, mac, now = new Date()) => {
      if (!challenge || challenge.tokenHash !== hash || challenge.consumedAt
        || challenge.sendCount >= 3 || challenge.expiresAt <= now) return 'denied';
      if (challenge.lastSentAt && now.getTime() - challenge.lastSentAt.getTime() < 60000) {
        return 'rate_limited';
      }
      challenge.otpHmac = mac;
      challenge.sendCount++;
      challenge.lastSentAt = now;
      return mac === null ? { status: 'reserved', sendCount: challenge.sendCount } : 'recorded';
    },
    mfaConfirmEmailDelivery: async (_userId, hash, mac, sendCount) => {
      if (!challenge || challenge.tokenHash !== hash || challenge.otpHmac !== null
        || challenge.consumedAt || challenge.sendCount !== sendCount) return false;
      challenge.otpHmac = mac;
      return true;
    },
    currentOtpHash: () => challenge?.otpHmac ?? null,
    mfaConsumeChallenge: async (input) => {
      if (!challenge || challenge.tokenHash !== input.tokenHash || challenge.consumedAt) {
        return { status: 'consumed' };
      }
      if (challenge.failedAttempts >= 5) return { status: 'attempts_exhausted' };
      const checked = await input.verify(setting, challenge);
      if (!checked.valid) {
        challenge.failedAttempts++;
        return { status: 'invalid' };
      }
      challenge.consumedAt = new Date();
      if (input.purpose === 'enroll') {
        if (!input.enrollmentRecoveryHashes || input.enrollmentRecoveryHashes.length !== 10) {
          throw new Error('missing recovery hashes');
        }
        hashes = input.enrollmentRecoveryHashes.slice();
        setting.state = 'active';
      }
      if (checked.totpStep !== undefined) setting.lastTotpStep = checked.totpStep;
      return { status: 'verified' };
    },
    storedHashes: () => hashes,
  };
  return fake;
}

async function withAuth(repo, delivery, run) {
  const service = new SecureGuardIdentityService(
    repo, 'synthetic-secure-guard-session-secret-for-ci', '1h',
    async (to, otp) => {
      delivery.push({ to, otp });
      if (delivery.fail) throw new Error('synthetic-unknown-email-delivery');
    }, keys);
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/secure-guard/auth', createSecureGuardAuthRouter(service, true));
  const server = await new Promise((resolve) => {
    const active = app.listen(0, '127.0.0.1', () => resolve(active));
  });
  const port = server.address().port;
  const post = (path, input) => fetch(`http://127.0.0.1:${port}/api/secure-guard/auth${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  try { await run(post, service); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

function assertNoSessionCookie(response) {
  assert.doesNotMatch(response.headers.get('set-cookie') || '', /secure_guard_session=[^;\s]+/);
}

function parseBase32(text) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const out = [];
  let value = 0;
  let bits = 0;
  for (const char of text) {
    value = ((value << 5) | alphabet.indexOf(char)) & 0x1fffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits -= 8)) & 255);
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(out);
}

test('email MFA login never issues a normal Cookie before OTP, even on wrong or replayed codes', async () => {
  const password = 'secure-test-personal-pass';
  const user = { id: 'user-email', email: 'email@example.test', passwordHash: await bcrypt.hash(password, 4),
    status: 'active', sessionVersion: 1 };
  const repo = inMemoryRepo(user, { userId: user.id, method: 'email', state: 'active' });
  const sent = [];
  await withAuth(repo, sent, async (post, service) => {
    const login = await post('/login', { email: user.email, password });
    assert.equal(login.status, 202);
    assertNoSessionCookie(login);
    const body = await login.json();
    assert.equal(body.flow, 'MFA_REQUIRED');
    assert.equal(body.method, 'email');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, user.email);
    const resend = await post('/mfa/email/resend', { challengeToken: body.challengeToken });
    assert.equal(resend.status, 429);
    const invalidCode = sent[0].otp === '123456' ? '654321' : '123456';
    const wrong = await post('/mfa/verify', { challengeToken: body.challengeToken, code: invalidCode });
    assert.equal(wrong.status, 401);
    assertNoSessionCookie(wrong);
    const verified = await post('/mfa/verify', { challengeToken: body.challengeToken, code: sent[0].otp });
    assert.equal(verified.status, 204);
    const cookie = verified.headers.get('set-cookie');
    assert.match(cookie, /secure_guard_session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    const token = cookie.match(/secure_guard_session=([^;]+)/)[1];
    const claims = jwt.verify(token, 'synthetic-secure-guard-session-secret-for-ci');
    assert.equal(claims.mfaVerified, true);
    assert.equal(claims.mfaMethod, 'email');
    assert.equal((await service.verifyActiveSession(service.verifySession(token))).id, user.id);
    const replay = await post('/mfa/verify', { challengeToken: body.challengeToken, code: sent[0].otp });
    assert.equal(replay.status, 401);
    assertNoSessionCookie(replay);
    const oldToken = jwt.sign({ userId: user.id, sessionVersion: 1 },
      'synthetic-secure-guard-session-secret-for-ci');
    assert.throws(() => service.verifySession(oldToken));
  });
});

test('email enrollment has one method selection, OTP verification and one-time recovery display', async () => {
  const password = 'secure-test-new-person';
  const user = { id: 'user-new-email', email: 'new@example.test',
    passwordHash: await bcrypt.hash(password, 4), status: 'active', sessionVersion: 1 };
  const repo = inMemoryRepo(user);
  const sent = [];
  await withAuth(repo, sent, async (post) => {
    const login = await post('/login', { email: user.email, password });
    assert.equal(login.status, 202);
    assertNoSessionCookie(login);
    const start = await login.json();
    assert.equal(start.flow, 'MFA_ENROLLMENT_REQUIRED');
    const setup = await post('/mfa/enroll/start', { challengeToken: start.challengeToken, method: 'email' });
    assert.equal(setup.status, 202);
    assertNoSessionCookie(setup);
    assert.equal(sent.length, 1);
    const second = await post('/mfa/enroll/start', { challengeToken: start.challengeToken, method: 'email' });
    assert.equal(second.status, 403);
    const enrolled = await post('/mfa/enroll/verify', {
      challengeToken: start.challengeToken, code: sent[0].otp,
    });
    assert.equal(enrolled.status, 200);
    const body = await enrolled.json();
    assert.equal(body.backupCodes.length, 10);
    assert.equal(repo.storedHashes().length, 10);
    assertNoSessionCookie(setup);
    assert.match(enrolled.headers.get('set-cookie'), /secure_guard_session=/);
    const used = await post('/mfa/enroll/verify', {
      challengeToken: start.challengeToken, code: sent[0].otp,
    });
    assert.equal(used.status, 401);
    assertNoSessionCookie(used);
  });
});

test('TOTP enrollment exposes an otpauth URI once and accepts only a real authenticator code', async () => {
  const password = 'secure-test-new-totp';
  const user = { id: 'user-new-totp', email: 'totp@example.test',
    passwordHash: await bcrypt.hash(password, 4), status: 'active', sessionVersion: 1 };
  const repo = inMemoryRepo(user);
  await withAuth(repo, [], async (post) => {
    const login = await post('/login', { email: user.email, password });
    assertNoSessionCookie(login);
    const flow = await login.json();
    const setup = await post('/mfa/enroll/start', { challengeToken: flow.challengeToken, method: 'totp' });
    assert.equal(setup.status, 200);
    assertNoSessionCookie(setup);
    const payload = await setup.json();
    const uri = new URL(payload.otpauthUrl);
    assert.equal(uri.protocol, 'otpauth:');
    assert.equal(uri.searchParams.get('algorithm'), 'SHA1');
    const secret = parseBase32(uri.searchParams.get('secret'));
    assert.equal(secret.length, 20);
    const retry = await post('/mfa/enroll/start', { challengeToken: flow.challengeToken, method: 'totp' });
    assert.equal(retry.status, 403);
    const code = totpAtStep(secret, BigInt(Math.floor(Date.now() / 30000)));
    const verified = await post('/mfa/enroll/verify', { challengeToken: flow.challengeToken, code });
    assert.equal(verified.status, 200);
    assert.equal((await verified.json()).backupCodes.length, 10);
    assert.match(verified.headers.get('set-cookie'), /secure_guard_session=/);
  });
});

test('SMTP failure cannot leave a verifiable email OTP or issue a normal session', async () => {
  const password = 'secure-unknown-delivery';
  const user = { id: 'unknown-mail', email: 'unknown@example.test',
    passwordHash: await bcrypt.hash(password, 4), status: 'active', sessionVersion: 1 };
  const repo = inMemoryRepo(user, { userId: user.id, method: 'email', state: 'active' });
  const delivery = [];
  delivery.fail = true;
  await withAuth(repo, delivery, async (post) => {
    const response = await post('/login', { email: user.email, password });
    assert.equal(response.status, 503);
    assertNoSessionCookie(response);
    assert.equal((await response.json()).error, 'MFA_UNAVAILABLE');
    assert.equal(delivery.length, 1);
    assert.equal(repo.currentOtpHash(), null);
  });
});

test('existing MFA Identity accepts membership without resetting factor or bypassing password', async () => {
  const password = 'existing-personal-secret';
  const user = { id: 'existing-mfa', email: 'existing@example.test',
    passwordHash: await bcrypt.hash(password, 4), status: 'active', sessionVersion: 2 };
  const repo = inMemoryRepo(user, { userId: user.id, method: 'totp', state: 'active' });
  await withAuth(repo, [], async (post) => {
    const withoutPassword = await post('/invitations/accept', {
      token: 'synthetic-existing-invite', password: 'incorrect-password',
    });
    assert.equal(withoutPassword.status, 202);
    assertNoSessionCookie(withoutPassword);
    assert.deepEqual(await withoutPassword.json(), { flow: 'MFA_LOGIN_REQUIRED' });
    assert.equal((await repo.mfaGetSetting(user.id)).state, 'active');

    const withPassword = await post('/invitations/accept', {
      token: 'synthetic-existing-invite', password,
    });
    assert.equal(withPassword.status, 202);
    assertNoSessionCookie(withPassword);
    const flow = await withPassword.json();
    assert.equal(flow.flow, 'MFA_REQUIRED');
    assert.equal(flow.method, 'totp');
  });
});

test('invitation acceptance is an MFA enrollment flow without normal JWT', async () => {
  const password = 'invite-password-2026!';
  const user = { id: 'invited-1', email: 'invited@example.test',
    passwordHash: await bcrypt.hash(password, 4), status: 'active', sessionVersion: 1 };
  const repo = inMemoryRepo(user);
  await withAuth(repo, [], async (post) => {
    const response = await post('/invitations/accept', { token: 'synthetic-invite-token', password });
    assert.equal(response.status, 202);
    assertNoSessionCookie(response);
    assert.equal((await response.json()).flow, 'MFA_ENROLLMENT_REQUIRED');
  });
});
