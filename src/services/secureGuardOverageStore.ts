import type { Pool } from 'pg';
import type { LicenseOverageResult } from './secureGuardLicenseOverage';

export interface SecureGuardOverageAlert {
  id: string;
  customerOrganizationId: string;
  organizationName: string;
  allocated: number;
  usage: number;
  overBy: number;
  openedAt: string;
  lastObservedAt: string;
  handlingStatus: 'open' | 'in_progress';
  responseChoice: 'reduce_clients' | 'increase_allocation' | null;
  responseNote: string | null;
  notificationStatus: 'pending' | 'attempting' | 'sent' | 'needs_review';
}

function validNumber(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647;
}

export class SecureGuardOverageStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Serialize each Organization under its existing row lock.
   * Unknown API observations do not open, close, or modify episodes.
   * The external DNSFilter Organization mapping must still match at write time.
   */
  async observe(
    customerOrganizationId: string,
    dnsfilterOrganizationId: string,
    comparison: LicenseOverageResult,
    observedAt: string,
  ): Promise<'opened' | 'updated' | 'resolved' | 'normal' | 'unavailable'> {
    if (comparison.status === 'unknown') return 'unavailable';
    if (!validNumber(comparison.usage) || !validNumber(comparison.allocated) ||
        !/^\d+$/.test(dnsfilterOrganizationId) || Number.isNaN(Date.parse(observedAt))) {
      return 'unavailable';
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const mapping = await client.query(`SELECT o.id FROM customer_organizations o
        JOIN dnsfilter_organization_mappings m
          ON m.customer_organization_id = o.id AND m.status = 'active'
        WHERE o.id = $1 AND o.status = 'active' AND m.dnsfilter_organization_id = $2
        FOR UPDATE OF o`, [customerOrganizationId, dnsfilterOrganizationId]);
      if (mapping.rows.length !== 1) {
        await client.query('ROLLBACK');
        return 'unavailable';
      }
      const existing = await client.query(`SELECT id FROM secure_guard_overage_alerts
        WHERE customer_organization_id = $1 AND resolved_at IS NULL FOR UPDATE`,
      [customerOrganizationId]);
      const id = existing.rows[0]?.id;
      if (comparison.status === 'overage') {
        if (comparison.overBy === null || !validNumber(comparison.overBy) || comparison.overBy === 0) {
          await client.query('ROLLBACK');
          return 'unavailable';
        }
        if (id) {
          await client.query(`UPDATE secure_guard_overage_alerts SET
            allocated_rc_licenses = $2, roaming_clients_in_use = $3, over_by = $4,
            last_observed_at = $5, updated_at = now() WHERE id = $1`,
          [id, comparison.allocated, comparison.usage, comparison.overBy, observedAt]);
        } else {
          await client.query(`INSERT INTO secure_guard_overage_alerts
            (customer_organization_id, allocated_rc_licenses, roaming_clients_in_use, over_by, last_observed_at)
            VALUES ($1, $2, $3, $4, $5)`,
          [customerOrganizationId, comparison.allocated, comparison.usage, comparison.overBy, observedAt]);
        }
        await client.query('COMMIT');
        return id ? 'updated' : 'opened';
      }
      if (id) {
        await client.query(`UPDATE secure_guard_overage_alerts SET
          handling_status = 'resolved', resolved_at = $2,
          last_observed_at = $2, updated_at = now()
          WHERE id = $1`, [id, observedAt]);
      }
      await client.query('COMMIT');
      return id ? 'resolved' : 'normal';
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listOpen(): Promise<SecureGuardOverageAlert[]> {
    const { rows } = await this.pool.query(`SELECT a.id, a.customer_organization_id,
      o.organization_name, a.allocated_rc_licenses, a.roaming_clients_in_use,
      a.over_by, a.opened_at, a.last_observed_at, a.handling_status,
      a.response_choice, a.response_note, a.notification_status
      FROM secure_guard_overage_alerts a
      JOIN customer_organizations o ON o.id = a.customer_organization_id
      WHERE a.resolved_at IS NULL ORDER BY a.opened_at DESC LIMIT 5000`);
    return rows.map((r) => ({
      id: String(r.id),
      customerOrganizationId: String(r.customer_organization_id),
      organizationName: String(r.organization_name),
      allocated: Number(r.allocated_rc_licenses),
      usage: Number(r.roaming_clients_in_use),
      overBy: Number(r.over_by),
      openedAt: new Date(r.opened_at).toISOString(),
      lastObservedAt: new Date(r.last_observed_at).toISOString(),
      handlingStatus: r.handling_status as SecureGuardOverageAlert['handlingStatus'],
      responseChoice: r.response_choice as SecureGuardOverageAlert['responseChoice'],
      responseNote: r.response_note === null ? null : String(r.response_note),
      notificationStatus: r.notification_status as SecureGuardOverageAlert['notificationStatus'],
    }));
  }

  async markInProgress(
    actorUserId: string, alertId: string,
    choice: 'reduce_clients' | 'increase_allocation', note: string | null,
  ): Promise<boolean> {
    if (!/^\d+$/.test(alertId)) return false;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(`UPDATE secure_guard_overage_alerts SET
        handling_status = 'in_progress', response_choice = $2, response_note = $3,
        response_updated_at = now(), response_updated_by = $4, updated_at = now()
        WHERE id = $1 AND resolved_at IS NULL RETURNING customer_organization_id`,
      [alertId, choice, note, actorUserId]);
      if (updated.rows.length !== 1) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(`INSERT INTO secure_guard_audit_events
        (actor_user_id, customer_organization_id, action, result)
        VALUES ($1, $2, 'license.overage.response.updated', 'success')`,
      [actorUserId, updated.rows[0].customer_organization_id]);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * One irreversible claim per episode. An ambiguous Slack delivery is
   * 'needs_review', never auto-retried (which could create duplicate posts).
   */
  async claimPendingNotification(): Promise<{
    id: string; organizationName: string; usage: number; allocated: number; checkedAt: string;
  } | null> {
    const { rows } = await this.pool.query(`WITH candidate AS (
        SELECT a.id FROM secure_guard_overage_alerts a
        JOIN customer_organizations o ON o.id = a.customer_organization_id AND o.status = 'active'
        JOIN dnsfilter_organization_mappings m
          ON m.customer_organization_id = o.id AND m.status = 'active'
        WHERE a.notification_status = 'pending' AND a.resolved_at IS NULL
        ORDER BY a.opened_at, a.id LIMIT 1 FOR UPDATE OF a SKIP LOCKED
      )
      UPDATE secure_guard_overage_alerts a SET
        notification_status = 'attempting', notification_attempted_at = now(), updated_at = now()
      FROM candidate c, customer_organizations o
      WHERE a.id = c.id AND o.id = a.customer_organization_id
      RETURNING a.id, o.organization_name, a.roaming_clients_in_use,
        a.allocated_rc_licenses, a.last_observed_at`);
    const r = rows[0];
    if (!r) return null;
    return {
      id: String(r.id),
      organizationName: String(r.organization_name),
      usage: Number(r.roaming_clients_in_use),
      allocated: Number(r.allocated_rc_licenses),
      checkedAt: new Date(r.last_observed_at).toISOString(),
    };
  }

  async completeNotification(id: string, result: 'sent' | 'needs_review'): Promise<void> {
    await this.pool.query(`UPDATE secure_guard_overage_alerts SET
      notification_status = $2, notification_sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE NULL END,
      updated_at = now()
      WHERE id = $1 AND notification_status = 'attempting'`, [id, result]);
  }
}
