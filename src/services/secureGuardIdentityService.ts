import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import type { CustomerRole, SecureGuardSessionPayload } from '../domain/secureGuard';
import type { SecureGuardMfaChallenge, SecureGuardMfaMethod, SecureGuardMfaSetting } from '../domain/secureGuardMfa';
import { SecureGuardRepo, type PortalUser } from './secureGuardRepo';
import {
  SecureGuardMfaCrypto, createMfaChallenge, hashMfaChallengeToken, verifyTotp,
} from './secureGuardMfa';

const BCRYPT_ROUNDS = 12;
const INVITATION_TTL_MS = 24 * 60 * 60 * 1000;

export type SecureGuardMfaLoginFlow = {
  flow: 'MFA_REQUIRED' | 'MFA_ENROLLMENT_REQUIRED';
  challengeToken: string;
  method?: SecureGuardMfaMethod;
};
export type SecureGuardInvitationFlow = SecureGuardMfaLoginFlow | { flow: 'MFA_LOGIN_REQUIRED' };
export type SecureGuardMfaEnrollmentStart = { otpauthUrl: string } | { delivery: 'sent' };
export type SecureGuardMfaEnrollmentSuccess = { sessionToken: string; backupCodes: string[] };

function base32(secret: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let value = 0;
  let bits = 0;
  let output = '';
  for (const byte of secret) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits -= 5)) & 31];
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

export class SecureGuardIdentityService {
  constructor(
    private readonly repo: SecureGuardRepo,
    private readonly jwtSecret: string,
    private readonly jwtExpiresIn: string,
    private readonly sendMfaEmail?: (to: string, code: string) => Promise<void>,
    private readonly mfaEnv: NodeJS.ProcessEnv = process.env,
  ) {}

  private crypto(): SecureGuardMfaCrypto {
    return new SecureGuardMfaCrypto(this.mfaEnv);
  }

  private async startChallenge(user: PortalUser): Promise<SecureGuardMfaLoginFlow> {
    this.crypto(); // Missing or invalid keys must STOP before creating a challenge.
    const setting = await this.repo.mfaGetSetting(user.id);
    const active = setting?.state === 'active';
    const purpose = active ? 'login' : 'enroll';
    const challenge = createMfaChallenge(purpose);
    if (!(await this.repo.mfaIssueChallenge({
      userId: user.id, tokenHash: challenge.tokenHash, purpose,
      method: active ? setting.method : null, expiresAt: challenge.expiresAt,
    }))) throw new Error('MFA_CHALLENGE_ISSUE_FAILED');
    if (active && setting.method === 'email') {
      const result = await this.deliverEmail(user, challenge.tokenHash);
      if (result !== 'sent') throw new Error('MFA_EMAIL_DELIVERY_UNAVAILABLE');
    }
    return active
      ? { flow: 'MFA_REQUIRED', challengeToken: challenge.token, method: setting.method }
      : { flow: 'MFA_ENROLLMENT_REQUIRED', challengeToken: challenge.token };
  }

  async login(email: string, password: string): Promise<SecureGuardMfaLoginFlow | null> {
    const user = await this.repo.findUserByEmail(email);
    if (!user || user.status !== 'active' || !user.passwordHash) return null;
    if (!(await bcrypt.compare(password, user.passwordHash))) return null;
    return this.startChallenge(user);
  }

  verifySession(token: string): SecureGuardSessionPayload {
    const decoded = jwt.verify(token, this.jwtSecret);
    if (!decoded || typeof decoded !== 'object'
      || typeof decoded.userId !== 'string'
      || !Number.isSafeInteger(decoded.sessionVersion)
      || decoded.mfaVerified !== true
      || (decoded.mfaMethod !== 'totp' && decoded.mfaMethod !== 'email')) {
      throw new Error('SECURE_GUARD_MFA_SESSION_REQUIRED');
    }
    return decoded as SecureGuardSessionPayload;
  }

  async verifyActiveSession(payload: SecureGuardSessionPayload): Promise<PortalUser | null> {
    if (payload.mfaVerified !== true ||
        (payload.mfaMethod !== 'totp' && payload.mfaMethod !== 'email')) return null;
    const user = await this.repo.findUserById(payload.userId);
    if (!user || user.status !== 'active' || user.sessionVersion !== payload.sessionVersion) return null;
    const factor = await this.repo.mfaGetSetting(user.id);
    return factor?.state === 'active' && factor.method === payload.mfaMethod ? user : null;
  }

  async createInvitation(input: {
    email: string;
    customerOrganizationId: string;
    role: CustomerRole;
    invitedByUserId: string;
    initialOnly?: boolean;
  }): Promise<{ token: string; expiresAt: Date }> {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    await this.repo.createInvitation({
      ...input,
      tokenHash: this.hashToken(token),
      expiresAt,
    });
    return { token, expiresAt };
  }

  async acceptInvitation(token: string, password: string): Promise<SecureGuardInvitationFlow | null> {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await this.repo.acceptInvitation(this.hashToken(token), passwordHash);
    if (!user) return null;
    // Accepting an additional membership never resets an active personal MFA.
    // If the pre-existing password differs, require a fresh login instead.
    const factor = await this.repo.mfaGetSetting(user.id);
    if (factor?.state === 'active' && user.passwordHash
      && !(await bcrypt.compare(password, user.passwordHash))) return { flow: 'MFA_LOGIN_REQUIRED' };
    return this.startChallenge(user);
  }

  private getLiveChallenge(token: string, purpose: 'login' | 'enroll'): Promise<SecureGuardMfaChallenge | null> {
    let tokenHash: string;
    try { tokenHash = hashMfaChallengeToken(token); } catch { return Promise.resolve(null); }
    return this.repo.mfaFindChallenge(tokenHash).then((challenge) => {
      if (!challenge || challenge.purpose !== purpose || challenge.consumedAt
        || challenge.expiresAt <= new Date() || challenge.failedAttempts >= 5) return null;
      return challenge;
    });
  }

  async startEnrollment(token: string, method: SecureGuardMfaMethod): Promise<SecureGuardMfaEnrollmentStart | null> {
    const challenge = await this.getLiveChallenge(token, 'enroll');
    if (!challenge || challenge.method !== null) return null;
    const user = await this.repo.findUserById(challenge.userId);
    if (!user || user.status !== 'active') return null;
    const mfa = this.crypto();
    if (method === 'email' && !this.sendMfaEmail) throw new Error('MFA_EMAIL_DELIVERY_UNAVAILABLE');

    let secret: Buffer | null = null;
    let encoded:
      | { ciphertext: Buffer; nonce: Buffer; tag: Buffer; keyVersion: number }
      | undefined;
    if (method === 'totp') {
      secret = mfa.generateTotpSecret();
      encoded = mfa.encryptTotp(user.id, secret);
    }
    const started = await this.repo.mfaStartEnrollment({
      userId: user.id, tokenHash: challenge.tokenHash, method,
      totpCiphertext: encoded?.ciphertext, totpNonce: encoded?.nonce,
      totpTag: encoded?.tag, keyVersion: encoded?.keyVersion,
    });
    if (!started) return null;
    if (method === 'email') {
      const result = await this.deliverEmail(user, challenge.tokenHash);
      if (result !== 'sent') throw new Error('MFA_EMAIL_DELIVERY_UNAVAILABLE');
      return { delivery: 'sent' };
    }
    const issuer = encodeURIComponent('atLIB Secure Guard');
    const label = encodeURIComponent(`atLIB Secure Guard:${user.email}`);
    const otpauthUrl = `otpauth://totp/${label}?secret=${base32(secret!)}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
    return { otpauthUrl };
  }

  private async checkCode(setting: SecureGuardMfaSetting | null,
    challenge: SecureGuardMfaChallenge, code: string, now: number,
  ): Promise<{ valid: boolean; totpStep?: bigint }> {
    if (!setting || setting.method !== challenge.method) return { valid: false };
    const mfa = this.crypto();
    if (setting.method === 'email') {
      return { valid: challenge.otpHmac !== null
        && mfa.matchesEmailOtp(challenge.userId, challenge.tokenHash, code, challenge.otpHmac) };
    }
    if (!setting.totpCiphertext || !setting.totpNonce || !setting.totpTag || !setting.keyVersion) {
      return { valid: false };
    }
    const secret = mfa.decryptTotp(setting.userId, {
      ciphertext: setting.totpCiphertext, nonce: setting.totpNonce,
      tag: setting.totpTag, keyVersion: 1,
    });
    const step = verifyTotp(secret, code, now, setting.lastTotpStep);
    return { valid: step !== null, totpStep: step ?? undefined };
  }

  private async verifiedToken(userId: string, method: SecureGuardMfaMethod): Promise<string> {
    const user = await this.repo.findUserById(userId);
    const setting = await this.repo.mfaGetSetting(userId);
    if (!user || user.status !== 'active' || setting?.state !== 'active'
      || setting.method !== method) throw new Error('MFA_SESSION_ISSUE_DENIED');
    const options: jwt.SignOptions = { expiresIn: this.jwtExpiresIn as jwt.SignOptions['expiresIn'] };
    return jwt.sign({
      userId: user.id, sessionVersion: user.sessionVersion,
      mfaVerified: true, mfaMethod: method,
    }, this.jwtSecret, options);
  }

  async verifyEnrollment(token: string, code: string): Promise<SecureGuardMfaEnrollmentSuccess | null> {
    const challenge = await this.getLiveChallenge(token, 'enroll');
    if (!challenge || !challenge.method) return null;
    const mfa = this.crypto();
    const { codes, hashes } = mfa.createRecoveryCodes(challenge.userId);
    const result = await this.repo.mfaConsumeChallenge({
      userId: challenge.userId, tokenHash: challenge.tokenHash, purpose: 'enroll',
      enrollmentRecoveryHashes: hashes,
      verify: (setting, current) => this.checkCode(setting, current, code, Date.now()),
    });
    if (result.status !== 'verified') return null;
    return {
      sessionToken: await this.verifiedToken(challenge.userId, challenge.method),
      backupCodes: codes,
    };
  }

  async verifyMfa(token: string, code: string): Promise<string | null> {
    const challenge = await this.getLiveChallenge(token, 'login');
    if (!challenge || !challenge.method) return null;
    const result = await this.repo.mfaConsumeChallenge({
      userId: challenge.userId, tokenHash: challenge.tokenHash, purpose: 'login',
      verify: (setting, current) => this.checkCode(setting, current, code, Date.now()),
    });
    return result.status === 'verified'
      ? this.verifiedToken(challenge.userId, challenge.method)
      : null;
  }

  private async deliverEmail(
    user: PortalUser, tokenHash: string,
  ): Promise<'sent' | 'denied' | 'rate_limited'> {
    if (!this.sendMfaEmail) throw new Error('MFA_EMAIL_DELIVERY_UNAVAILABLE');
    const mfa = this.crypto();
    const otp = mfa.generateEmailOtp();
    const status = await this.repo.mfaRecordEmailOtp(
      user.id, tokenHash, mfa.emailOtpHmac(user.id, tokenHash, otp),
    );
    if (status !== 'recorded') return status;
    // Fail closed on SMTP error/unknown delivery; do not return the OTP or retry.
    await this.sendMfaEmail(user.email, otp);
    return 'sent';
  }

  async resendEmail(token: string): Promise<'sent' | 'denied' | 'rate_limited'> {
    let hash: string;
    try { hash = hashMfaChallengeToken(token); } catch { return 'denied'; }
    const challenge = await this.repo.mfaFindChallenge(hash);
    if (!challenge || (challenge.purpose !== 'login' && challenge.purpose !== 'enroll')
      || challenge.method !== 'email' || challenge.consumedAt
      || challenge.expiresAt <= new Date() || challenge.failedAttempts >= 5) return 'denied';
    const user = await this.repo.findUserById(challenge.userId);
    if (!user || user.status !== 'active') return 'denied';
    return this.deliverEmail(user, hash);
  }

  async replaceInitialInvitation(input: {
    email: string;
    customerOrganizationId: string;
    invitedByUserId: string;
  }): Promise<{ token: string; expiresAt: Date }> {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    await this.repo.replaceInitialInvitation({ ...input, tokenHash: this.hashToken(token), expiresAt });
    return { token, expiresAt };
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }
}
