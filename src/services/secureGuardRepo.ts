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

export interface ManagedOrganization {
  id: string;
  organizationName: string;
  status: 'active' | 'suspended';
  dnsfilterOrganizationId: string | null;
  mappingStatus: 'active' | 'disabled' | null;
  allocatedLicenses: number | null;
  licenseSnapshotUpdatedAt: string | null;
}
export interface LicenseAlertState {
  organizationId: string;
  organizationName: string;
  dnsfilterOrganizationId: string;
  allocatedLicenses: number | null;
  licenseSnapshotUpdatedAt: string | null;
}
export interface ManagedMembership { id: string; email: string; role: CustomerRole; status: 'pending' | 'active' | 'revoked'; isInitialAdmin: boolean; }
export interface AuditEvent { id: string; organizationName: string | null; action: string; result: 'success' | 'denied' | 'failed'; createdAt: string; }
export interface AgentUninstallClaim {
  id: string;
  agentUuid: string;
  hostname: string;
  siteId: string;
  status: 'pending_unknown' | 'accepted' | 'unknown';
  createdAt: string;
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
      `SELECT m.id AS membership_id, m.customer_organization_id, o.organization_name, m.role
       FROM customer_memberships m
       JOIN customer_organizations o ON o.id = m.customer_organization_id AND o.status = 'active'
       WHERE m.user_id = $1 AND m.status = 'active'
       ORDER BY o.organization_name`,
      [userId],
    );
    return rows.map((row) => this.mapScope(row));
  }

  async findActiveScope(userId: string, membershipId: string): Promise<CustomerScope | null> {
    const { rows } = await this.pool.query(
      `SELECT m.id AS membership_id, m.customer_organization_id, o.organization_name, m.role
       FROM customer_memberships m
       JOIN customer_organizations o ON o.id = m.customer_organization_id AND o.status = 'active'
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

  async listManagedOrganizations(): Promise<ManagedOrganization[]> {
    const { rows } = await this.pool.query(`SELECT o.id, o.organization_name, o.status, m.dnsfilter_organization_id, m.status AS mapping_status,
      o.dnsfilter_allocated_rc_licenses_snapshot, o.license_snapshot_updated_at
      FROM customer_organizations o LEFT JOIN dnsfilter_organization_mappings m ON m.customer_organization_id = o.id ORDER BY o.organization_name`);
    return rows.map((r) => this.mapManagedOrganization(r));
  }

  async createManagedOrganization(actorUserId: string, organizationName: string, dnsfilterOrganizationId?: string): Promise<ManagedOrganization> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const created = await client.query(`INSERT INTO customer_organizations (organization_name, status) VALUES ($1, 'active') RETURNING id, organization_name, status`, [organizationName]);
      const row = created.rows[0];
      if (!row) throw new SecureGuardConflictError('CUSTOMER_ORGANIZATION_NOT_FOUND');
      if (dnsfilterOrganizationId) await client.query(`INSERT INTO dnsfilter_organization_mappings (customer_organization_id, dnsfilter_organization_id, status) VALUES ($1, $2, 'active')`, [row.id, dnsfilterOrganizationId]);
      await this.insertAudit(client, actorUserId, String(row.id), null, 'organization.created', 'success');
      await client.query('COMMIT');
      return { id: String(row.id), organizationName: String(row.organization_name), status: 'active', dnsfilterOrganizationId: dnsfilterOrganizationId ?? null, mappingStatus: dnsfilterOrganizationId ? 'active' : null, allocatedLicenses: null, licenseSnapshotUpdatedAt: null };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async createProvisioningDraft(actorUserId: string, organizationName: string): Promise<ManagedOrganization> {
    const { rows } = await this.pool.query(`INSERT INTO customer_organizations (organization_name, status) VALUES ($1, 'suspended') RETURNING id, organization_name`, [organizationName]);
    const row = rows[0]; if (!row) throw new SecureGuardConflictError('CUSTOMER_ORGANIZATION_NOT_FOUND');
    await this.recordSystemAudit(actorUserId, 'organization.provisioning.started', 'success');
    return { id: String(row.id), organizationName: String(row.organization_name), status: 'suspended', dnsfilterOrganizationId: null, mappingStatus: null, allocatedLicenses: null, licenseSnapshotUpdatedAt: null };
  }

  async finalizeProvisioning(actorUserId: string, organizationId: string, dnsfilterOrganizationId: string): Promise<ManagedOrganization | null> {
    return this.updateManagedOrganization(actorUserId, organizationId, { status: 'active', dnsfilterOrganizationId });
  }

  async updateManagedOrganization(actorUserId: string, organizationId: string, input: { organizationName?: string; status?: 'active' | 'suspended'; dnsfilterOrganizationId?: string }): Promise<ManagedOrganization | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query(`SELECT id, organization_name, status FROM customer_organizations WHERE id = $1 FOR UPDATE`, [organizationId]);
      if (!found.rows[0]) { await client.query('ROLLBACK'); return null; }
      const current = found.rows[0];
      const name = input.organizationName ?? String(current.organization_name);
      const status = input.status ?? current.status;
      const updated = await client.query(`UPDATE customer_organizations SET organization_name = $1, status = $2, updated_at = now() WHERE id = $3 RETURNING id, organization_name, status`, [name, status, organizationId]);
      if (input.dnsfilterOrganizationId !== undefined) await client.query(`INSERT INTO dnsfilter_organization_mappings (customer_organization_id, dnsfilter_organization_id, status) VALUES ($1, $2, 'active') ON CONFLICT (customer_organization_id) DO UPDATE SET dnsfilter_organization_id = EXCLUDED.dnsfilter_organization_id, status = 'active', updated_at = now()`, [organizationId, input.dnsfilterOrganizationId]);
      await this.insertAudit(client, actorUserId, organizationId, null, 'organization.updated', 'success');
      const mapping = await client.query(`SELECT dnsfilter_organization_id, status FROM dnsfilter_organization_mappings WHERE customer_organization_id = $1`, [organizationId]);
      await client.query('COMMIT');
      const r = updated.rows[0]!; const m = mapping.rows[0];
      return { id: String(r.id), organizationName: String(r.organization_name), status: r.status as ManagedOrganization['status'], dnsfilterOrganizationId: m ? String(m.dnsfilter_organization_id) : null, mappingStatus: m ? m.status as ManagedOrganization['mappingStatus'] : null, allocatedLicenses: null, licenseSnapshotUpdatedAt: null };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async listManagedMemberships(organizationId: string): Promise<ManagedMembership[]> {
    const { rows } = await this.pool.query(`SELECT m.id, u.email, m.role, m.status, m.is_initial_admin FROM customer_memberships m JOIN portal_users u ON u.id = m.user_id WHERE m.customer_organization_id = $1 ORDER BY u.email`, [organizationId]);
    return rows.map((r) => ({ id: String(r.id), email: String(r.email), role: r.role as CustomerRole, status: r.status as ManagedMembership['status'], isInitialAdmin: Boolean(r.is_initial_admin) }));
  }

  async updateMembershipRole(actorUserId: string, organizationId: string, membershipId: string, role: CustomerRole): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN'); await this.lockInitialOrganization(client, organizationId);
      const target = await client.query(`SELECT role, status FROM customer_memberships WHERE id = $1 AND customer_organization_id = $2 FOR UPDATE`, [membershipId, organizationId]);
      if (!target.rows[0]) { await client.query('ROLLBACK'); return false; }
      if (target.rows[0].role === 'org_admin' && role !== 'org_admin' && target.rows[0].status === 'active') {
        const count = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM customer_memberships WHERE customer_organization_id = $1 AND role = 'org_admin' AND status = 'active'`, [organizationId]);
        if (count.rows[0]?.count === '1') throw new SecureGuardConflictError('LAST_ORG_ADMIN');
      }
      await client.query(`UPDATE customer_memberships SET role = $1, updated_at = now() WHERE id = $2`, [role, membershipId]);
      await this.insertAudit(client, actorUserId, organizationId, membershipId, 'membership.role.updated', 'success'); await client.query('COMMIT'); return true;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async listAuditEvents(organizationId?: string): Promise<AuditEvent[]> {
    const args: string[] = []; const filter = organizationId ? (args.push(organizationId), 'WHERE e.customer_organization_id = $1') : '';
    const { rows } = await this.pool.query(`SELECT e.id, o.organization_name, e.action, e.result, e.created_at FROM secure_guard_audit_events e LEFT JOIN customer_organizations o ON o.id = e.customer_organization_id ${filter} ORDER BY e.created_at DESC LIMIT 100`, args);
    return rows.map((r) => ({ id: String(r.id), organizationName: r.organization_name === null ? null : String(r.organization_name), action: String(r.action), result: r.result as AuditEvent['result'], createdAt: new Date(r.created_at).toISOString() }));
  }

  async recordSystemAudit(actorUserId: string, action: string, result: 'success' | 'failed'): Promise<void> {
    await this.pool.query(`INSERT INTO secure_guard_audit_events (actor_user_id, action, result) VALUES ($1, $2, $3)`, [actorUserId, action, result]);
  }

  /** Resolves the external Organization only from the authenticated customer's active server-side scope. */
  async findActiveDnsFilterOrganization(customerOrganizationId: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      `SELECT m.dnsfilter_organization_id
       FROM dnsfilter_organization_mappings m
       JOIN customer_organizations o ON o.id = m.customer_organization_id AND o.status = 'active'
       WHERE m.customer_organization_id = $1 AND m.status = 'active'`,
      [customerOrganizationId],
    );
    const organizationId = rows[0]?.dnsfilter_organization_id;
    return typeof organizationId === 'string' && /^\d+$/.test(organizationId) ? organizationId : null;
  }

  /** Transactionally rechecks the live actor/scope/mapping, then commits claim AND audit before any DELETE. */
  async claimAgentUninstall(input: {
    operationId: string; actorUserId: string; scope: CustomerScope; dnsfilterOrganizationId: string;
    agentUuid: string; siteId: string; hostname: string;
  }): Promise<'claimed' | 'duplicate' | 'denied'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const authorized = await client.query(
        `SELECT m.id
         FROM customer_memberships m
         JOIN portal_users u ON u.id = m.user_id AND u.status = 'active'
         JOIN customer_organizations o ON o.id = m.customer_organization_id AND o.status = 'active'
         JOIN dnsfilter_organization_mappings d ON d.customer_organization_id = o.id AND d.status = 'active'
         WHERE m.id = $1 AND m.user_id = $2 AND m.customer_organization_id = $3
           AND m.status = 'active' AND m.role IN ('org_admin', 'operator')
           AND d.dnsfilter_organization_id = $4
         FOR SHARE OF m, u, o, d`,
        [input.scope.membershipId, input.actorUserId, input.scope.customerOrganizationId, input.dnsfilterOrganizationId],
      );
      if (!authorized.rows[0]) { await client.query('ROLLBACK'); return 'denied'; }
      const inserted = await client.query(
        `INSERT INTO secure_guard_agent_uninstall_claims
           (id, actor_user_id, membership_id, customer_organization_id, dnsfilter_organization_id, agent_uuid, site_id, hostname)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (agent_uuid) DO NOTHING RETURNING id`,
        [input.operationId, input.actorUserId, input.scope.membershipId, input.scope.customerOrganizationId,
          input.dnsfilterOrganizationId, input.agentUuid, input.siteId, input.hostname],
      );
      if (!inserted.rows[0]) { await client.query('ROLLBACK'); return 'duplicate'; }
      await this.insertAudit(client, input.actorUserId, input.scope.customerOrganizationId, input.scope.membershipId, 'agent.uninstall.claimed', 'success');
      await client.query('COMMIT');
      return 'claimed';
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async finishAgentUninstall(operationId: string, actorUserId: string, scope: CustomerScope, status: 'accepted' | 'unknown'): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        `UPDATE secure_guard_agent_uninstall_claims SET status = $1, result_at = now()
         WHERE id = $2 AND customer_organization_id = $3 AND actor_user_id = $4 AND status = 'pending_unknown'
         RETURNING id`,
        [status, operationId, scope.customerOrganizationId, actorUserId],
      );
      if (!updated.rows[0]) { await client.query('ROLLBACK'); return false; }
      await this.insertAudit(client, actorUserId, scope.customerOrganizationId, scope.membershipId,
        status === 'accepted' ? 'agent.uninstall.request.accepted' : 'agent.uninstall.outcome.unknown',
        status === 'accepted' ? 'success' : 'failed');
      await client.query('COMMIT');
      return true;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async getAgentUninstallClaim(customerOrganizationId: string, agentUuid: string): Promise<AgentUninstallClaim | null> {
    const { rows } = await this.pool.query(
      `SELECT id, agent_uuid, site_id, hostname, status, created_at
       FROM secure_guard_agent_uninstall_claims
       WHERE customer_organization_id = $1 AND agent_uuid = $2`,
      [customerOrganizationId, agentUuid],
    );
    const row = rows[0];
    return row ? { id: String(row.id), agentUuid: String(row.agent_uuid), siteId: String(row.site_id),
      hostname: String(row.hostname), status: row.status as AgentUninstallClaim['status'],
      createdAt: new Date(row.created_at).toISOString() } : null;
  }

  async getLicenseAlertState(customerOrganizationId: string): Promise<LicenseAlertState | null> {
    const { rows } = await this.pool.query(
      `SELECT o.id, o.organization_name, o.dnsfilter_allocated_rc_licenses_snapshot, o.license_snapshot_updated_at,
              m.dnsfilter_organization_id
       FROM customer_organizations o
       JOIN dnsfilter_organization_mappings m ON m.customer_organization_id = o.id AND m.status = 'active'
       WHERE o.id = $1 AND o.status = 'active'`,
      [customerOrganizationId],
    );
    const row = rows[0];
    if (!row || typeof row.dnsfilter_organization_id !== 'string' || !/^\d+$/.test(row.dnsfilter_organization_id)) return null;
    return {
      organizationId: String(row.id),
      organizationName: String(row.organization_name),
      dnsfilterOrganizationId: row.dnsfilter_organization_id,
      allocatedLicenses: row.dnsfilter_allocated_rc_licenses_snapshot === null ? null : Number(row.dnsfilter_allocated_rc_licenses_snapshot),
      licenseSnapshotUpdatedAt: row.license_snapshot_updated_at === null ? null : new Date(row.license_snapshot_updated_at).toISOString(),
    };
  }

  async updateLicenseAllocation(actorUserId: string, customerOrganizationId: string, allocatedLicenses: number): Promise<LicenseAlertState | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        `UPDATE customer_organizations o
         SET dnsfilter_allocated_rc_licenses_snapshot = $1,
             license_snapshot_updated_at = now(), license_snapshot_updated_by = $2, updated_at = now()
         WHERE o.id = $3 AND o.status = 'active'
           AND EXISTS (SELECT 1 FROM dnsfilter_organization_mappings m WHERE m.customer_organization_id = o.id AND m.status = 'active')
         RETURNING o.id, o.organization_name, o.dnsfilter_allocated_rc_licenses_snapshot, o.license_snapshot_updated_at`,
        [allocatedLicenses, actorUserId, customerOrganizationId],
      );
      if (!updated.rows[0]) { await client.query('ROLLBACK'); return null; }
      await this.insertAudit(client, actorUserId, customerOrganizationId, null, 'license.allocation.snapshot.updated', 'success');
      const mapping = await client.query(`SELECT dnsfilter_organization_id FROM dnsfilter_organization_mappings WHERE customer_organization_id = $1 AND status = 'active'`, [customerOrganizationId]);
      await client.query('COMMIT');
      const row = updated.rows[0];
      return { organizationId: String(row.id), organizationName: String(row.organization_name), dnsfilterOrganizationId: String(mapping.rows[0]!.dnsfilter_organization_id), allocatedLicenses: Number(row.dnsfilter_allocated_rc_licenses_snapshot), licenseSnapshotUpdatedAt: new Date(row.license_snapshot_updated_at).toISOString() };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async claimLicenseAlert(customerOrganizationId: string, overage: number, token: string): Promise<'claimed' | 'duplicate' | 'pending' | 'missing'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(`SELECT license_alert_last_sent_overage, license_alert_pending_token FROM customer_organizations WHERE id = $1 FOR UPDATE`, [customerOrganizationId]);
      if (!locked.rows[0]) { await client.query('ROLLBACK'); return 'missing'; }
      if (Number(locked.rows[0].license_alert_last_sent_overage) === overage) { await client.query('ROLLBACK'); return 'duplicate'; }
      if (locked.rows[0].license_alert_pending_token !== null) { await client.query('ROLLBACK'); return 'pending'; }
      await client.query(`UPDATE customer_organizations SET license_alert_pending_overage = $1, license_alert_pending_token = $2, license_alert_pending_at = now() WHERE id = $3`, [overage, token, customerOrganizationId]);
      await client.query('COMMIT'); return 'claimed';
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async completeLicenseAlert(actorUserId: string, customerOrganizationId: string, token: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`UPDATE customer_organizations SET license_alert_last_sent_overage = license_alert_pending_overage, license_alert_last_sent_at = now(), license_alert_pending_overage = NULL, license_alert_pending_token = NULL, license_alert_pending_at = NULL WHERE id = $1 AND license_alert_pending_token = $2`, [customerOrganizationId, token]);
      if (result.rowCount !== 1) { await client.query('ROLLBACK'); return false; }
      await this.insertAudit(client, actorUserId, customerOrganizationId, null, 'license.overage.slack.sent', 'success');
      await client.query('COMMIT'); return true;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async failLicenseAlert(customerOrganizationId: string, token: string): Promise<void> {
    await this.pool.query(`UPDATE customer_organizations SET license_alert_pending_overage = NULL, license_alert_pending_token = NULL, license_alert_pending_at = NULL WHERE id = $1 AND license_alert_pending_token = $2`, [customerOrganizationId, token]);
  }

  async clearResolvedLicenseAlert(customerOrganizationId: string): Promise<void> {
    await this.pool.query(`UPDATE customer_organizations SET license_alert_last_sent_overage = NULL, license_alert_last_sent_at = NULL WHERE id = $1 AND license_alert_pending_token IS NULL`, [customerOrganizationId]);
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

  private mapManagedOrganization(row: Record<string, unknown>): ManagedOrganization {
    return {
      id: String(row.id),
      organizationName: String(row.organization_name),
      status: row.status as ManagedOrganization['status'],
      dnsfilterOrganizationId: row.dnsfilter_organization_id === null ? null : String(row.dnsfilter_organization_id),
      mappingStatus: row.mapping_status === null ? null : row.mapping_status as ManagedOrganization['mappingStatus'],
      allocatedLicenses: row.dnsfilter_allocated_rc_licenses_snapshot === null || row.dnsfilter_allocated_rc_licenses_snapshot === undefined ? null : Number(row.dnsfilter_allocated_rc_licenses_snapshot),
      licenseSnapshotUpdatedAt: row.license_snapshot_updated_at === null || row.license_snapshot_updated_at === undefined ? null : new Date(row.license_snapshot_updated_at as string | Date).toISOString(),
    };
  }
}

export class SecureGuardConflictError extends Error {
  constructor(readonly code: 'CUSTOMER_ORGANIZATION_NOT_FOUND' | 'INITIAL_ADMIN_ALREADY_SET' | 'INITIAL_ADMIN_INVITATION_PENDING' | 'MEMBERSHIP_ALREADY_EXISTS' | 'LAST_ORG_ADMIN') {
    super(code);
  }
}
