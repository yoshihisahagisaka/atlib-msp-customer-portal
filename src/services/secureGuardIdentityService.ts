import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import type { CustomerRole, SecureGuardSessionPayload } from '../domain/secureGuard';
import { SecureGuardRepo, type PortalUser } from './secureGuardRepo';

const BCRYPT_ROUNDS = 12;
const INVITATION_TTL_MS = 24 * 60 * 60 * 1000;

export class SecureGuardIdentityService {
  constructor(
    private readonly repo: SecureGuardRepo,
    private readonly jwtSecret: string,
    private readonly jwtExpiresIn: string,
  ) {}

  async login(email: string, password: string): Promise<string | null> {
    const user = await this.repo.findUserByEmail(email);
    if (!user || user.status !== 'active' || !user.passwordHash) return null;
    if (!(await bcrypt.compare(password, user.passwordHash))) return null;
    return this.issueSession(user);
  }

  verifySession(token: string): SecureGuardSessionPayload {
    return jwt.verify(token, this.jwtSecret) as SecureGuardSessionPayload;
  }

  async verifyActiveSession(payload: SecureGuardSessionPayload): Promise<PortalUser | null> {
    const user = await this.repo.findUserById(payload.userId);
    if (!user || user.status !== 'active' || user.sessionVersion !== payload.sessionVersion) return null;
    return user;
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

  async acceptInvitation(token: string, password: string): Promise<string | null> {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await this.repo.acceptInvitation(this.hashToken(token), passwordHash);
    return user ? this.issueSession(user) : null;
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

  private issueSession(user: PortalUser): string {
    const options: jwt.SignOptions = { expiresIn: this.jwtExpiresIn as jwt.SignOptions['expiresIn'] };
    return jwt.sign({ userId: user.id, sessionVersion: user.sessionVersion }, this.jwtSecret, options);
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }
}
