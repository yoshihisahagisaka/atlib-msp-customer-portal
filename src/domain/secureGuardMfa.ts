/**
 * Secure Guard V1: MFA belongs to a personal Identity, never a tenant.
 * All limits are fixed here; there is no per-organization configuration.
 */
export const MFA_CHALLENGE_TTL_MS = 10 * 60 * 1000;
export const MFA_ADMIN_REAUTH_TTL_MS = 5 * 60 * 1000;
export const MFA_MAX_FAILED_ATTEMPTS = 5;
export const MFA_EMAIL_RESEND_INTERVAL_MS = 60 * 1000;
export const MFA_MAX_EMAIL_SENDS = 3;
export const MFA_TOTP_PERIOD_SECONDS = 30;
export const MFA_TOTP_WINDOW_STEPS = 1;
export const MFA_RECOVERY_CODE_COUNT = 10;
export const MFA_RECOVERY_CODE_BYTES = 16;
export const MFA_TOTP_SECRET_BYTES = 20;
export const MFA_CHALLENGE_TOKEN_BYTES = 32;
export const MFA_KEY_VERSION = 1;

export type SecureGuardMfaMethod = 'totp' | 'email';
export type SecureGuardMfaState = 'enrolling' | 'active' | 'reset_required';
export type SecureGuardMfaPurpose = 'login' | 'enroll' | 'recovery' | 'admin_reauth';

export interface SecureGuardMfaEncryptedTotp {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
  keyVersion: 1;
}

export interface SecureGuardMfaSetting {
  userId: string;
  method: SecureGuardMfaMethod;
  state: SecureGuardMfaState;
  totpCiphertext: Buffer | null;
  totpNonce: Buffer | null;
  totpTag: Buffer | null;
  keyVersion: number | null;
  lastTotpStep: bigint | null;
}

export interface SecureGuardMfaChallenge {
  tokenHash: string;
  userId: string;
  purpose: SecureGuardMfaPurpose;
  method: SecureGuardMfaMethod | null;
  otpHmac: string | null;
  expiresAt: Date;
  failedAttempts: number;
  sendCount: number;
  lastSentAt: Date | null;
  verifiedAt: Date | null;
  consumedAt: Date | null;
}

export type SecureGuardMfaChallengeResult =
  | { status: 'verified' }
  | { status: 'invalid' | 'expired' | 'consumed' | 'attempts_exhausted' | 'purpose_mismatch' };
