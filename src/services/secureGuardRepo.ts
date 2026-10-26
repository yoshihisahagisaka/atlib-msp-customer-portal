import type { Pool, PoolClient } from 'pg';
import type { CustomerRole, CustomerScope } from '../domain/secureGuard';

export interface PortalUser {
  id: string;
  email: string;
  passwordHash: string | null;
  status: 'invited' | 'active' | 'disabled';
  sessionVersion: number;
}

export interface Membership extends CustomerScope {
  userId: string;
  status: 'pending' | 'active' | 'revoked';
}

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

export class SecureGuardRepo {
  constructor(private readonly pool: Pool) {}

  async findUserByEmail(email: string): Promise<PortalUser | null> {
    const { rows } = await this.pool.query(
      `SELECT id, email, password_hash, status, session_version
       FROM portal_users WHERE lower(email) = lower($1)`,
      [email],
    );
    return rows[0] ? this.mapUser(rows[0]) : null;
  }

  async findUserById(userId: string): Promise<PortalUser | null> {
    const { rows } = await this.pool.query(
      'SELECT id, email, password_hash, status, session_version FROM portal_users WHERE id = $1',
      [userId],
    );
    return rows[0] ? this.mapUser(rows[0]) : null;
  }

  async listActiveMemberships(userId: string): Promise<CustomerScope[]> {
    const { rows } = await this.pool.query(
      `SELECT m.id AS membership_id, m.customer_organization_id, c.company_name AS organization_name, m.role
       FROM customer_memberships m
       JOIN customer_organizations o ON o.id = m.customer_organization_id AND o.status = 'active'
       JOIN customers c ON c.id = o.customer_id AND c.status = 'active'
       WHERE m.user_id = $1 AND m.status = 'active'
       ORDER BY c.company_name`,
      [userId],
    );
    return rows.map((row) => this.mapScope(row));
  }

  async findActiveScope(userId: string, membershipId: string): Promise<CustomerScope | null> {
    const { rows } = await this.pool.query(
      `SELECT m.id AS membership_id, m.customer_organization_id, c.company_name AS organization_name, m.role
       FROM customer_memberships m
       JOIN customer_organizations o ON o.id = m.customer_organization_id AND o.status = 'active'
       JOIN customers c ON c.id = o.customer_id AND c.status = 'active'
       WHERE m.id = $1 AND m.user_id = $2 AND m.status = 'active'`,
      [membershipId, userId],
    );
    return rows[0] ? this.mapScope(rows[0]) : null;
  }

  async hasActiveMspAdminGrant(userId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM msp_role_grants
       WHERE user_id = $1 AND role = 'msp_admin' AND status = 'active'`,
      [userId],
    );
    return rows.length === 1;
  }

  async createInvitation(input: {
    email: string;
    customerOrganizationId: string;
    role: CustomerRole;
    invitedByUserId: string;
    tokenHash: string;
    expiresAt: Date;
    initialOnly?: boolean;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (input.initialOnly) {
        const organization = await client.query(
          'SELECT id FROM customer_organizations WHERE id = $1 FOR UPDATE',
          [input.customerOrganizationId],
        );
        if (!organization.rows[0]) throw new SecureGuardConflictError('CUSTOMER_ORGANIZATION_NOT_FOUND');
        const count = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM customer_memberships
           WHERE customer_organization_id = $1 AND role = 'org_admin' AND status = 'active'`,
          [input.customerOrganizationId],
        );
        if (count.rows[0]?.count !== '0') throw new SecureGuardConflictError('INITIAL_ADMIN_ALREADY_SET');
        const pending = await client.query(
          `SELECT id FROM customer_memberships
           WHERE customer_organization_id = $1 AND is_initial_admin = true AND status = 'pending'
           FOR UPDATE`,
          [input.customerOrganizationId],
        );
        if (pending.rows[0]) throw new SecureGuardConflictError('INITIAL_ADMIN_INVITATION_PENDING');
      }
      const user = await this.findOrCreateInvitedUser(client, input.email);
      const existing = await client.query(
        `SELECT status FROM customer_memberships
         WHERE user_id = $1 AND customer_organization_id = $2 FOR UPDATE`,
        [user.id, input.customerOrganizationId],
      );
      if (existing.rows[0]?.status === 'active') throw new SecureGuardConflictError('MEMBERSHIP_ALREADY_EXISTS');
      if (existing.rows.length > 0) {
        // A pending invitation may be re-sent after mail delivery failure or expiry. A revoked membership
        // is restored only by this explicit, fresh invitation and must be accepted again.
        await client.query(
          `UPDATE customer_memberships
           SET role = $1, is_initial_admin = $2, status = 'pending', invited_by_user_id = $3, invite_token_hash = $4,
               invite_expires_at = $5, accepted_at = NULL, revoked_at = NULL, updated_at = now()
           WHERE user_id = $6 AND customer_organization_id = $7`,
          [input.role, input.initialOnly ?? false, input.invitedByUserId, input.tokenHash, input.expiresAt, user.id, input.customerOrganizationId],
        );
      } else {
        await client.query(
          `INSERT INTO customer_memberships
           (user_id, customer_organization_id, role, is_initial_admin, status, invited_by_user_id, invite_token_hash, invite_expires_at)
           VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7)`,
          [
            user.id,
            input.customerOrganizationId,
            input.role,
            input.initialOnly ?? false,
            input.invitedByUserId,
            input.tokenHash,
            input.expiresAt,
          ],
        );
      }
      await this.insertAudit(client, input.invitedByUserId, input.customerOrganizationId, null, 'membership.invited', 'success');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async acceptInvitation(tokenHash: string, passwordHash: string): Promise<PortalUser | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query(
        `SELECT m.id AS membership_id, m.user_id, m.customer_organization_id, u.status AS user_status
         FROM customer_memberships m
         JOIN portal_users u ON u.id = m.user_id
         WHERE m.invite_token_hash = $1 AND m.status = 'pending' AND m.invite_expires_at > now()
         FOR UPDATE`,
        [tokenHash],
      );
      const membership = found.rows[0];
      if (!membership) {
        await client.query('ROLLBACK');
        return null;
      }
      if (membership.user_status === 'disabled') {
        await client.query('ROLLBACK');
        return null;
      }
      if (membership.user_status === 'invited') {
        await client.query(
          `UPDATE portal_users
           SET password_hash = $1, status = 'active', session_version = session_version + 1, updated_at = now()
           WHERE id = $2`,
          [passwordHash, membership.user_id],
        );
      }
      await client.query(
        `UPDATE customer_memberships
         SET status = 'active', invite_token_hash = NULL, invite_expires_at = NULL, accepted_at = now(), updated_at = now()
         WHERE id = $1`,
        [membership.membership_id],
      );
      await this.insertAudit(client, membership.user_id, membership.customer_organization_id, membership.membership_id, 'membership.accepted', 'success');
      const user = await client.query(
        'SELECT id, email, password_hash, status, session_version FROM portal_users WHERE id = $1',
        [membership.user_id],
      );
      await client.query('COMMIT');
      return user.rows[0] ? this.mapUser(user.rows[0]) : null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async cancelInitialInvitation(actorUserId: string, customerOrganizationId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lockInitialOrganization(client, customerOrganizationId);
      const pending = await client.query(
        `SELECT id FROM customer_memberships
         WHERE customer_organization_id = $1 AND is_initial_admin = true AND status = 'pending'
         FOR UPDATE`,
        [customerOrganizationId],
      );
      const membershipId = pending.rows[0]?.id;
      if (!membershipId) {
        await client.query('ROLLBACK');
        return false;
      }
      await this.cancelPendingInitialInvitation(client, membershipId);
      await this.insertAudit(client, actorUserId, customerOrganizationId, membershipId, 'initial_admin.invitation.cancelled', 'success');
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async replaceInitialInvitation(input: {
    email: string;
    customerOrganizationId: string;
    invitedByUserId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lockInitialOrganization(client, input.customerOrganizationId);
      const active = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM customer_memberships
         WHERE customer_organization_id = $1 AND role = 'org_admin' AND status = 'active'`,
        [input.customerOrganizationId],
      );
      if (active.rows[0]?.count !== '0') throw new SecureGuardConflictError('INITIAL_ADMIN_ALREADY_SET');
      const pending = await client.query(
        `SELECT id FROM customer_memberships
         WHERE customer_organization_id = $1 AND is_initial_admin = true AND status = 'pending'
         FOR UPDATE`,
        [input.customerOrganizationId],
      );
      const previousMembershipId = pending.rows[0]?.id as string | undefined;
      if (previousMembershipId) {
        await this.cancelPendingInitialInvitation(client, previousMembershipId);
        await this.insertAudit(
          client,
          input.invitedByUserId,
          input.customerOrganizationId,
          previousMembershipId,
          'initial_admin.invitation.cancelled',
          'success',
        );
      }
      const user = await this.findOrCreateInvitedUser(client, input.email);
      const existing = await client.query(
        `SELECT status FROM customer_memberships
         WHERE user_id = $1 AND customer_organization_id = $2 FOR UPDATE`,
        [user.id, input.customerOrganizationId],
      );
      if (existing.rows[0]?.status === 'active') throw new SecureGuardConflictError('MEMBERSHIP_ALREADY_EXISTS');
      if (existing.rows.length > 0) {
        await client.query(
          `UPDATE customer_memberships
           SET role = 'org_admin', is_initial_admin = true, status = 'pending', invited_by_user_id = $1,
               invite_token_hash = $2, invite_expires_at = $3, accepted_at = NULL, revoked_at = NULL, updated_at = now()
           WHERE user_id = $4 AND customer_organization_id = $5`,
          [input.invitedByUserId, input.tokenHash, input.expiresAt, user.id, input.customerOrganizationId],
        );
      } else {
        await client.query(
          `INSERT INTO customer_memberships
           (user_id, customer_organization_id, role, is_initial_admin, status, invited_by_user_id, invite_token_hash, invite_expires_at)
           VALUES ($1, $2, 'org_admin', true, 'pending', $3, $4, $5)`,
          [user.id, input.customerOrganizationId, input.invitedByUserId, input.tokenHash, input.expiresAt],
        );
      }
      await this.insertAudit(client, input.invitedByUserId, input.customerOrganizationId, null, 'initial_admin.invitation.reissued', 'success');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeMembership(actorUserId: string, scope: CustomerScope, membershipId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT id FROM customer_organizations WHERE id = $1 FOR UPDATE',
        [scope.customerOrganizationId],
      );
      const target = await client.query(
        `SELECT id, role FROM customer_memberships
         WHERE id = $1 AND customer_organization_id = $2 AND status = 'active' FOR UPDATE`,
        [membershipId, scope.customerOrganizationId],
      );
      if (!target.rows[0]) {
        await client.query('ROLLBACK');
        return false;
      }
      if (target.rows[0].role === 'org_admin') {
        const admins = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM customer_memberships
           WHERE customer_organization_id = $1 AND role = 'org_admin' AND status = 'active'`,
          [scope.customerOrganizationId],
        );
        if (admins.rows[0]?.count === '1') throw new SecureGuardConflictError('LAST_ORG_ADMIN');
      }
      await client.query(
        `UPDATE customer_memberships
         SET status = 'revoked', revoked_at = now(), invite_token_hash = NULL, invite_expires_at = NULL, updated_at = now()
         WHERE id = $1`,
        [membershipId],
      );
      await this.insertAudit(client, actorUserId, scope.customerOrganizationId, membershipId, 'membership.revoked', 'success');
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async findOrCreateInvitedUser(client: PoolClient, email: string): Promise<PortalUser> {
    const existing = await client.query(
      'SELECT id, email, password_hash, status, session_version FROM portal_users WHERE lower(email) = lower($1) FOR UPDATE',
      [email],
    );
    if (existing.rows[0]) return this.mapUser(existing.rows[0]);
    const inserted = await client.query(
      `INSERT INTO portal_users (email, status) VALUES (lower($1), 'invited')
       RETURNING id, email, password_hash, status, session_version`,
      [email],
    );
    return this.mapUser(inserted.rows[0]);
  }

  private async lockInitialOrganization(client: PoolClient, customerOrganizationId: string): Promise<void> {
    const organization = await client.query(
      'SELECT id FROM customer_organizations WHERE id = $1 FOR UPDATE',
      [customerOrganizationId],
    );
    if (!organization.rows[0]) throw new SecureGuardConflictError('CUSTOMER_ORGANIZATION_NOT_FOUND');
  }

  private async cancelPendingInitialInvitation(client: PoolClient, membershipId: string): Promise<void> {
    await client.query(
      `UPDATE customer_memberships
       SET status = 'revoked', revoked_at = now(), invite_token_hash = NULL, invite_expires_at = NULL, updated_at = now()
       WHERE id = $1`,
      [membershipId],
    );
  }

  private async insertAudit(
    client: PoolClient,
    actorUserId: string,
    customerOrganizationId: string,
    membershipId: string | null,
    action: string,
    result: 'success' | 'denied' | 'failed',
  ): Promise<void> {
    await client.query(
      `INSERT INTO secure_guard_audit_events
       (actor_user_id, customer_organization_id, membership_id, action, result)
       VALUES ($1, $2, $3, $4, $5)`,
      [actorUserId, customerOrganizationId, membershipId, action, result],
    );
  }

  private mapUser(row: Record<string, unknown>): PortalUser {
    return {
      id: String(row.id),
      email: String(row.email),
      passwordHash: row.password_hash === null ? null : String(row.password_hash),
      status: row.status as PortalUser['status'],
      sessionVersion: Number(row.session_version),
    };
  }

  private mapScope(row: Record<string, unknown>): CustomerScope {
    return {
      membershipId: String(row.membership_id),
      customerOrganizationId: String(row.customer_organization_id),
      organizationName: String(row.organization_name),
      role: row.role as CustomerRole,
    };
  }
}

export class SecureGuardConflictError extends Error {
  constructor(readonly code: 'CUSTOMER_ORGANIZATION_NOT_FOUND' | 'INITIAL_ADMIN_ALREADY_SET' | 'INITIAL_ADMIN_INVITATION_PENDING' | 'MEMBERSHIP_ALREADY_EXISTS' | 'LAST_ORG_ADMIN') {
    super(code);
  }
}
