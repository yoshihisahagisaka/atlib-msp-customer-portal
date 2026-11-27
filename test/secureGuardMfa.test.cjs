const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  SecureGuardMfaCrypto, createMfaChallenge, hashMfaChallengeToken,
  totpAtStep, verifyTotp,
} = require('../dist/services/secureGuardMfa');
const {
  MFA_CHALLENGE_TTL_MS, MFA_ADMIN_REAUTH_TTL_MS, MFA_RECOVERY_CODE_COUNT,
  MFA_MAX_FAILED_ATTEMPTS, MFA_MAX_EMAIL_SENDS,
} = require('../dist/domain/secureGuardMfa');

function keys() {
  return {
    SECURE_GUARD_MFA_ENCRYPTION_KEY_V1: Buffer.alloc(32, 41).toString('base64'),
    SECURE_GUARD_MFA_OTP_PEPPER: Buffer.alloc(32, 73).toString('base64'),
  };
}

test('MFA refuses absent, malformed, or short crypto keys (no default secrets)', () => {
  for (const env of [{}, { SECURE_GUARD_MFA_ENCRYPTION_KEY_V1: 'abc', SECURE_GUARD_MFA_OTP_PEPPER: 'abc' },
    { ...keys(), SECURE_GUARD_MFA_OTP_PEPPER: undefined }]) {
    assert.throws(() => new SecureGuardMfaCrypto(env), /SECURE_GUARD_MFA_SECRET_UNAVAILABLE/);
  }
});

test('RFC6238 SHA1 fixed timestamps use last 6 digits, +-1 window, and step replay is denied', () => {
  const secret = Buffer.from('12345678901234567890', 'ascii');
  const vectors = [
    [59, '287082'], [1111111109, '081804'], [1111111111, '050471'],
    [1234567890, '005924'], [2000000000, '279037'],
  ];
  for (const [seconds, code] of vectors) {
    const step = BigInt(Math.floor(seconds / 30));
    assert.equal(totpAtStep(secret, step), code);
    assert.equal(verifyTotp(secret, code, seconds * 1000, null), step);
    assert.equal(verifyTotp(secret, code, seconds * 1000, step), null);
  }
  assert.equal(verifyTotp(secret, totpAtStep(secret, 2n), 30_000, null), 2n);
  assert.equal(verifyTotp(secret, '123', 59_000, null), null);
  assert.equal(verifyTotp(secret, '000000', -1, null), null);
  assert.equal(MFA_MAX_FAILED_ATTEMPTS, 5);
  assert.equal(MFA_MAX_EMAIL_SENDS, 3);
});

test('AES-GCM encrypts 20-byte TOTP secrets and binds ciphertext to the user and version', () => {
  const mfa = new SecureGuardMfaCrypto(keys());
  const secret = mfa.generateTotpSecret();
  assert.equal(secret.length, 20);
  const encrypted = mfa.encryptTotp('user-a', secret);
  assert.notDeepEqual(encrypted.ciphertext, secret);
  assert.equal(encrypted.nonce.length, 12);
  assert.equal(encrypted.tag.length, 16);
  assert.deepEqual(mfa.decryptTotp('user-a', encrypted), secret);
  assert.throws(() => mfa.decryptTotp('user-b', encrypted));
  assert.throws(() => mfa.decryptTotp('user-a', { ...encrypted, keyVersion: 2 }), /UNSUPPORTED_MFA_KEY_OR_SHAPE/);
  const tampered = { ...encrypted, tag: Buffer.from(encrypted.tag) };
  tampered.tag[0] ^= 1;
  assert.throws(() => mfa.decryptTotp('user-a', tampered));
  const otherKey = new SecureGuardMfaCrypto({ ...keys(), SECURE_GUARD_MFA_ENCRYPTION_KEY_V1: Buffer.alloc(32, 99).toString('base64') });
  assert.throws(() => otherKey.decryptTotp('user-a', encrypted));
});

test('challenge tokens are unique, opaque and 10min or 5min with SHA256 persistence', () => {
  const a = createMfaChallenge('login', 10_000);
  const b = createMfaChallenge('login', 10_000);
  const reauth = createMfaChallenge('admin_reauth', 10_000);
  assert.notEqual(a.token, b.token);
  assert.match(a.token, /^[a-f0-9]{64}$/);
  assert.equal(hashMfaChallengeToken(a.token), a.tokenHash);
  assert.notEqual(a.tokenHash, a.token);
  assert.equal(a.expiresAt.getTime() - 10_000, MFA_CHALLENGE_TTL_MS);
  assert.equal(reauth.expiresAt.getTime() - 10_000, MFA_ADMIN_REAUTH_TTL_MS);
  assert.throws(() => hashMfaChallengeToken('invalid'), /INVALID_MFA_CHALLENGE_TOKEN/);
});

test('email OTP HMAC and recovery-code HMAC are identity-bound, no plaintext persisted', () => {
  const mfa = new SecureGuardMfaCrypto(keys());
  const a = createMfaChallenge('login');
  const otp = mfa.generateEmailOtp();
  assert.match(otp, /^\d{6}$/);
  const mac = mfa.emailOtpHmac('user-a', a.tokenHash, otp);
  assert.match(mac, /^[a-f0-9]{64}$/);
  assert.equal(mfa.matchesEmailOtp('user-a', a.tokenHash, otp, mac), true);
  assert.equal(mfa.matchesEmailOtp('user-b', a.tokenHash, otp, mac), false);
  assert.equal(mfa.matchesEmailOtp('user-a', a.tokenHash, 'bad', mac), false);
  assert.equal(mfa.canResendEmail(new Date(100_000), 1, 159_999), false);
  assert.equal(mfa.canResendEmail(new Date(100_000), 1, 160_000), true);
  assert.equal(mfa.canResendEmail(new Date(100_000), 3, 999_999), false);
  const { codes, hashes } = mfa.createRecoveryCodes('user-a');
  assert.equal(codes.length, MFA_RECOVERY_CODE_COUNT);
  assert.equal(new Set(codes).size, MFA_RECOVERY_CODE_COUNT);
  assert.equal(new Set(hashes).size, MFA_RECOVERY_CODE_COUNT);
  assert.ok(codes.every((code) => /^[0-9a-f]{32}$/.test(code)));
  assert.ok(hashes.every((mac) => /^[0-9a-f]{64}$/.test(mac)));
  assert.equal(hashes[0], mfa.recoveryCodeHmac('user-a', codes[0]));
  assert.notEqual(hashes[0], mfa.recoveryCodeHmac('user-b', codes[0]));
});
