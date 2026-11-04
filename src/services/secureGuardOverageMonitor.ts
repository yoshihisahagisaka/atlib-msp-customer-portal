import type { SecureGuardRepo } from './secureGuardRepo';
import type { DnsFilterRoamingUsageClient } from './dnsFilterRoamingUsageClient';
import type { SecureGuardOverageStore } from './secureGuardOverageStore';
import { compareConfirmedLicenseUsage } from './secureGuardLicenseOverage';
import { sendSecureGuardOverageSlack } from './secureGuardOverageSlack';

export interface OverageMonitorSummary {
  checked: number;
  unavailable: number;
  opened: number;
  resolved: number;
  notificationsSent: number;
  notificationsNeedReview: number;
}

/**
 * One scheduler-triggered iteration (scheduling is intentionally not deployed).
 * DNSFilter reads are Organization-scoped GET only, no license/billing mutation.
 * No Slack claim is made until a dedicated webhook has been explicitly configured.
 */
export async function runSecureGuardOverageCheck(input: {
  repo: Pick<SecureGuardRepo, 'listManagedOrganizations'>;
  client: Pick<DnsFilterRoamingUsageClient, 'getRoamingUsage'>;
  store: Pick<SecureGuardOverageStore, 'observe' | 'claimPendingNotification' | 'completeNotification'>;
  slackWebhook?: string;
  managementUrl?: string;
}): Promise<OverageMonitorSummary> {
  const summary: OverageMonitorSummary = {
    checked: 0, unavailable: 0, opened: 0, resolved: 0,
    notificationsSent: 0, notificationsNeedReview: 0,
  };
  const organizations = await input.repo.listManagedOrganizations();
  for (const organization of organizations) {
    if (organization.status !== 'active' || organization.mappingStatus !== 'active' ||
        !organization.dnsfilterOrganizationId) continue;
    try {
      const usage = await input.client.getRoamingUsage(organization.dnsfilterOrganizationId);
      const comparison = compareConfirmedLicenseUsage(
        usage.roamingClientsInUse, usage.dnsfilterAllocatedRoamingClients,
      );
      const outcome = await input.store.observe(
        organization.id, organization.dnsfilterOrganizationId, comparison, usage.retrievedAt,
      );
      if (outcome === 'unavailable') summary.unavailable++;
      else {
        summary.checked++;
        if (outcome === 'opened') summary.opened++;
        if (outcome === 'resolved') summary.resolved++;
      }
    } catch {
      // Failed or ambiguous reads must never create/rescind alerts.
      summary.unavailable++;
    }
  }

  if (!input.slackWebhook) return summary;
  // One pass for only the backlog present at the start, never an unbounded loop.
  const maxClaims = Math.max(organizations.length, 1);
  for (let claimNumber = 0; claimNumber < maxClaims; claimNumber++) {
    const notification = await input.store.claimPendingNotification();
    if (!notification) break;
    const delivery = await sendSecureGuardOverageSlack(input.slackWebhook, {
      organizationName: notification.organizationName,
      usage: notification.usage,
      allocated: notification.allocated,
      checkedAt: notification.checkedAt,
      managementUrl: input.managementUrl,
    });
    await input.store.completeNotification(
      notification.id, delivery === 'sent' ? 'sent' : 'needs_review',
    );
    if (delivery === 'sent') summary.notificationsSent++;
    else summary.notificationsNeedReview++;
  }
  return summary;
}
