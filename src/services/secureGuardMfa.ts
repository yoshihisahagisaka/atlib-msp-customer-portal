import * as crypto from 'node:crypto';
import {
  MFA_CHALLENGE_TOKEN_BYTES, MFA_CHALLENGE_TTL_MS, MFA_ADMIN_REAUTH_TTL_MS,
  MFA_EMAIL_RESEND_INTERVAL_MS, MFA_KEY_VERSION, MFA_RECOVERY_CODE_BYTES,
  MFA_RECOVERY_CODE_COUNT, MFA_TOTP_PERIOD_SECONDS, MFA_TOTP_SECRET_BYTES,
  MFA_TOTP_WINDOW_STEPS, type SecureGuardMfaEncryptedTotp,
  type SecureGuardMfaPurpose,
} from '../domain/secureGuardMfa';

function requireKey(base64: string | undefined): Buffer {
  if (!base64 || !/^[A-Za-z0-9+/]{43}=$/.test(base64)) throw new Error('SECURE_GUARD_MFA_SECRET_UNAVAILABLE');
  const decoded = Buffer.from(base64, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== base64) {
    throw new Error('SECURE_GUARD_MFA_SECRET_UNAVAILABLE');
  }
  return decoded;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Pure RFC-6238 HOTP-SHA1 truncated to 6 digits for standard authenticators. */
export function totpAtStep(secret: Buffer, step: bigint): string {
  if (secret.length !== MFA_TOTP_SECRET_BYTES || step < 0n || step > 18446744073709551615n) {
    throw new Error('INVALID_TOTP_INPUT');
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(step);
  const digest = crypto.createHmac('sha1', secret).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24)
    | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8)
    | digest[offset + 3]!;
  return (binary % 1_000_000).toString().padStart(6, '0');
}

/** Reject an already accepted 30-second step, including within the +/-1 window. */
export function verifyTotp(
  secret: Buffer, candidate: string, nowMs: number,
  lastAcceptedStep: bigint | null,
): bigint | null {
  if (!/^\d{6}$/.test(candidate) || !Number.isSafeInteger(nowMs) || nowMs < 0) return null;
  const current = BigInt(Math.floor(nowMs / (MFA_TOTP_PERIOD_SECONDS * 1000)));
  for (let delta = -MFA_TOTP_WINDOW_STEPS; delta <= MFA_TOTP_WINDOW_STEPS; delta++) {
    const step = current + BigInt(delta);
    if (step < 0n || (lastAcceptedStep !== null && step <= lastAcceptedStep)) continue;
    const valid = totpAtStep(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(valid))) return step;
  }
  return null;
}

function challengeLifetime(purpose: SecureGuardMfaPurpose): number {
  return purpose === 'admin_reauth' ? MFA_ADMIN_REAUTH_TTL_MS : MFA_CHALLENGE_TTL_MS;
}

export function createMfaChallenge(purpose: SecureGuardMfaPurpose, now = Date.now()): {
  token: string; tokenHash: string; expiresAt: Date;
} {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('INVALID_MFA_TIME');
  const token = crypto.randomBytes(MFA_CHALLENGE_TOKEN_BYTES).toString('hex');
  return { token, tokenHash: sha256(token), expiresAt: new Date(now + challengeLifetime(purpose)) };
}

export function hashMfaChallengeToken(token: string): string {
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('INVALID_MFA_CHALLENGE_TOKEN');
  return sha256(token);
}

/** Node crypto only. AES key and low-entropy HMAC pepper must never be in SQL/logs. */
export class SecureGuardMfaCrypto {
  private readonly encryptionKey: Buffer;
  private readonly otpPepper: Buffer;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.encryptionKey = requireKey(env.SECURE_GUARD_MFA_ENCRYPTION_KEY_V1);
    this.otpPepper = requireKey(env.SECURE_GUARD_MFA_OTP_PEPPER);
  }

  generateTotpSecret(): Buffer {
    return crypto.randomBytes(MFA_TOTP_SECRET_BYTES);
  }

  encryptTotp(userId: string, secret: Buffer): SecureGuardMfaEncryptedTotp {
    if (!userId || secret.length !== MFA_TOTP_SECRET_BYTES) throw new Error('INVALID_TOTP_INPUT');
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, nonce);
    cipher.setAAD(Buffer.from(`${userId}|secure_guard_totp_v1`, 'utf8'));
    return {
      ciphertext: Buffer.concat([cipher.update(secret), cipher.final()]),
      nonce, tag: cipher.getAuthTag(), keyVersion: MFA_KEY_VERSION,
    };
  }

  decryptTotp(userId: string, encrypted: SecureGuardMfaEncryptedTotp): Buffer {
    if (encrypted.keyVersion !== MFA_KEY_VERSION || encrypted.nonce.length !== 12
      || encrypted.tag.length !== 16 || encrypted.ciphertext.length !== MFA_TOTP_SECRET_BYTES) {
      throw new Error('UNSUPPORTED_MFA_KEY_OR_SHAPE');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, encrypted.nonce);
    decipher.setAAD(Buffer.from(`${userId}|secure_guard_totp_v1`, 'utf8'));
    decipher.setAuthTag(encrypted.tag);
    const secret = Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
    if (secret.length !== MFA_TOTP_SECRET_BYTES) throw new Error('INVALID_TOTP_SHAPE');
    return secret;
  }

  generateEmailOtp(): string {
    return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  emailOtpHmac(userId: string, challengeHash: string, otp: string): string {
    if (!userId || !/^[a-f0-9]{64}$/.test(challengeHash) || !/^\d{6}$/.test(otp)) {
      throw new Error('INVALID_MFA_OTP_INPUT');
    }
    return crypto.createHmac('sha256', this.otpPepper)
      .update(`${userId}|${challengeHash}|${otp}`, 'utf8').digest('hex');
  }

  matchesEmailOtp(userId: string, challengeHash: string, otp: string, expected: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(expected) || !/^\d{6}$/.test(otp)) return false;
    return crypto.timingSafeEqual(
      Buffer.from(this.emailOtpHmac(userId, challengeHash, otp), 'hex'),
      Buffer.from(expected, 'hex'),
    );
  }

  recoveryCodeHmac(userId: string, code: string): string {
    if (!userId || !/^[a-f0-9]{32}$/.test(code)) throw new Error('INVALID_MFA_RECOVERY_CODE');
    return crypto.createHmac('sha256', this.otpPepper)
      .update(`${userId}|${code}`, 'utf8').digest('hex');
  }

  createRecoveryCodes(userId: string): { codes: string[]; hashes: string[] } {
    const codes = Array.from({ length: MFA_RECOVERY_CODE_COUNT },
      () => crypto.randomBytes(MFA_RECOVERY_CODE_BYTES).toString('hex'));
    return { codes, hashes: codes.map((code) => this.recoveryCodeHmac(userId, code)) };
  }

  canResendEmail(lastSentAt: Date | null, sendCount: number, now = Date.now()): boolean {
    return sendCount < 3 && (!lastSentAt || now - lastSentAt.getTime() >= MFA_EMAIL_RESEND_INTERVAL_MS);
  }
}
