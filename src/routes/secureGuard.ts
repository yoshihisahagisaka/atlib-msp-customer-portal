import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CustomerRole } from '../domain/secureGuard';
import {
  requireMspAdmin,
  requireSecureGuardCustomerScope,
  requireSecureGuardIdentity,
} from '../middleware/secureGuardAuth';
import type { Mailer } from '../services/mailer';
import type { SecureGuardIdentityService } from '../services/secureGuardIdentityService';
import { SecureGuardConflictError, type SecureGuardRepo } from '../services/secureGuardRepo';
import { DnsFilterInventoryClient } from '../services/dnsFilterInventoryClient';
import { DnsFilterAgentUninstallClient } from '../services/dnsFilterAgentUninstallClient';
import { DnsFilterRoamingUsageClient } from '../services/dnsFilterRoamingUsageClient';
import { compareConfirmedLicenseUsage } from '../services/secureGuardLicenseOverage';
import type { SecureGuardOverageStore } from '../services/secureGuardOverageStore';
import type { SecureGuardInventory } from '../domain/secureGuardInventory';
import { DnsFilterManagementClient, DnsFilterManagementError } from '../services/dnsFilterManagementClient';
import type { SecureGuardLicenseSlack } from '../services/secureGuardLicenseSlack';
import { synchronizeManagedOrganizations } from '../services/secureGuardOrganizationSync';

const membershipRoleSchema = z.enum(['org_admin', 'operator', 'viewer']);
const invitationSchema = z.object({ email: z.string().email(), role: membershipRoleSchema });
const initialInvitationSchema = z.object({
  customerOrganizationId: z.string().uuid(),
  email: z.string().email(),
});
const initialInvitationCancelSchema = z.object({ customerOrganizationId: z.string().uuid() });
const organizationSchema = z.object({ organizationName: z.string().trim().min(1).max(255), dnsfilterOrganizationId: z.string().regex(/^\d+$/).optional() });
const organizationPatchSchema = z.object({ organizationName: z.string().trim().min(1).max(255).optional(), status: z.enum(['active', 'suspended']).optional(), dnsfilterOrganizationId: z.string().regex(/^\d+$/).optional() }).refine((value) => Object.keys(value).length > 0);
const managedInvitationSchema = z.object({ email: z.string().email(), role: membershipRoleSchema });
const roleUpdateSchema = z.object({ role: membershipRoleSchema });
const provisioningSchema = z.object({ organizationName: z.string().trim().min(1).max(255) });
const importSchema = z.object({ organizationName: z.string().trim().min(1).max(255), dnsfilterOrganizationId: z.string().regex(/^\d+$/) });
const networkIdSchema = z.string().regex(/^[1-9]\d*$/).refine((value) => Number.isSafeInteger(Number(value)));
const networkSchema = z.object({
  name: z.string().trim().min(1).max(255),
  policyIds: z.array(networkIdSchema).min(1).max(10).refine((values) => new Set(values).size === values.length),
  blockPageId: networkIdSchema,
  externalId: z.string().trim().min(1).max(255),
});
const recoverySchema = z.object({ dnsfilterOrganizationId: z.string().regex(/^\d+$/) });
const licenseAllocationSchema = z.object({ allocatedLicenses: z.number().int().min(0).max(10_000_000) });
const overageHandlingSchema = z.object({
  responseChoice: z.enum(['reduce_clients', 'increase_allocation']),
  responseNote: z.string().trim().max(500).nullable().optional(),
}).strict();
const agentUuidSchema = z.string().uuid();
const agentUninstallSchema = z.object({
  siteId: networkIdSchema,
  hostname: z.string().min(1).max(255),
  confirmHostname: z.string().min(1).max(255),
  acknowledgeCommunicationRisk: z.literal(true),
}).strict();

function toError(error: unknown, res: { status: (code: number) => { json: (value: unknown) => void } }): boolean {
  if (!(error instanceof SecureGuardConflictError)) return false;
  const status = error.code === 'LAST_ORG_ADMIN' ? 409 : 409;
  res.status(status).json({ error: error.code });
  return true;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '23505';
}

export function createSecureGuardRouter(input: {
  identityService: SecureGuardIdentityService;
  repo: SecureGuardRepo;
  inventoryClient: DnsFilterInventoryClient;
  mailer: Mailer;
  portalBaseUrl: string;
  managementClient?: DnsFilterManagementClient;
  roamingUsageClient?: DnsFilterRoamingUsageClient;
  overageStore?: Pick<SecureGuardOverageStore, 'listOpen' | 'markInProgress'>;
  licenseAlertSlack?: SecureGuardLicenseSlack;
  // Dedicated DB uses the scheduled overage Job as the only Slack owner.
  // The old manual delivery remains compatible only with the legacy Portal mode.
  manualLicenseAlertDeliveryEnabled?: boolean;
  agentUninstallClient?: DnsFilterAgentUninstallClient;
  agentUninstallEnabled?: boolean;
}): Router {
  const router = Router();
  const requireIdentity = requireSecureGuardIdentity(input.identityService);
  const requireCustomerScope = requireSecureGuardCustomerScope(input.repo);
  const management = () => { if (!input.managementClient) throw new DnsFilterManagementError('DNSFILTER_UNAVAILABLE'); return input.managementClient; };
  // A deployment flag, a configured server-only client and the Migration gate are all required.
  const agentUninstallReady = Boolean(input.agentUninstallEnabled && input.agentUninstallClient?.isConfigured());

  const loadInventory = async (customerOrganizationId: string): Promise<SecureGuardInventory | null> => {
    try {
      const dnsfilterOrganizationId = await input.repo.findActiveDnsFilterOrganization(customerOrganizationId);
      if (!dnsfilterOrganizationId) return null;
      return await input.inventoryClient.getInventory(dnsfilterOrganizationId);
    } catch {
      // Neither a missing mapping nor an upstream failure may be represented as an empty successful inventory.
      return null;
    }
  };

  router.get('/me', requireIdentity, async (req, res) => {
    const memberships = await input.repo.listActiveMemberships(req.secureGuardUserId!);
    const mspAdmin = await input.repo.hasActiveMspAdminGrant(req.secureGuardUserId!);
    res.json({ memberships, mspAdmin });
  });

  // MSP administration stays in the same authenticated application, but never grants a Customer scope implicitly.
  router.get('/admin/organizations', requireIdentity, requireMspAdmin(input.repo), async (_req, res) => {
    res.json({ organizations: await input.repo.listManagedOrganizations() });
  });
  router.post('/admin/organizations', requireIdentity, requireMspAdmin(input.repo), async (req, res) => {
    const parsed = organizationSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'INVALID_REQUEST' });
    try { res.status(201).json(await input.repo.createManagedOrganization(req.secureGuardUserId!, parsed.data.organizationName, parsed.data.dnsfilterOrganizationId)); }
    catch (error) { res.status(isUniqueViolation(error) ? 409 : 500).json({ error: isUniqueViolation(error) ? 'ORGANIZATION_CONFLICT' : 'ORGANIZATION_UNAVAILABLE' }); }
  });
  router.patch('/admin/organizations/:organizationId', requireIdentity, requireMspAdmin(input.repo), async (req, res) => {
    const parsed = organizationPatchSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'INVALID_REQUEST' });
    try { const updated = await input.repo.updateManagedOrganization(req.secureGuardUserId!, req.params.organizationId!, parsed.data); if (!updated) return void res.status(404).json({ error: 'ORGANIZATION_NOT_FOUND' }); res.json(updated); }
    catch (error) { res.status(isUniqueViolation(error) ? 409 : 500).json({ error: isUniqueViolation(error) ? 'ORGANIZATION_CONFLICT' : 'ORGANIZATION_UNAVAILABLE' }); }
  });
  // Read-only official source, separate from the operator-transcribed snapshot.
  router.get('/admin/organizations/:organizationId/roaming-license-usage', requireIdentity, requireMspAdmin(input.repo), async (req, res) => {
    const organizationId = req.params.organizationId!;
    if (!z.string().uuid().safeParse(organizationId).success) {
      res.status(400).json({ error: 'INVALID_REQUEST' });
      return;
    }
    if (!input.roamingUsageClient) {
      res.status(503).json({ error: 'ROAMING_USAGE_UNAVAILABLE' });
      return;
    }
    try {
      const organizations = await input.repo.listManagedOrganizations();
      const organization = organizations.find((candidate) => candidate.id === organizationId);
      if (!organization || organization.status !== 'active' || organization.mappingStatus !== 'active' ||
          !organization.dnsfilterOrganizationId) {
        res.status(404).json({ error: 'ORGANIZATION_NOT_FOUND' });
        return;
      }
      const usage = await input.roamingUsageClient.getRoamingUsage(organization.dnsfilterOrganizationId);
      const comparison = compareConfirmedLicenseUsage(
        usage.roamingClientsInUse, usage.dnsfilterAllocatedRoamingClients,
      );
      res.json({
        organizationId,
        source: 'dnsfilter.organization_usage_detailed',
        allocated: usage.dnsfilterAllocatedRoamingClients,
        usage: usage.roamingClientsInUse,
        status: comparison.status,
        overBy: comparison.overBy,
        observedAt: usage.retrievedAt,
        periodFrom: usage.from,
        periodTo: usage.to,
      });
    } catch {
      res.status(502).json({ error: 'ROAMING_USAGE_UNAVAILABLE' });
    }
  });
  // Internal MSP human response tracking only; never a DNSFilter license or billing write.
  router.get('/admin/overage-alerts', requireIdentity, requireMspAdmin(input.repo), async (_req, res) => {
    if (!input.overageStore) return void res.status(503).json({ error: 'OVERAGE_MONITOR_UNAVAILABLE' });
    try { res.json({ alerts: await input.overageStore.listOpen() }); }
    catch { res.status(503).json({ error: 'OVERAGE_MONITOR_UNAVAILABLE' }); }
  });
  router.patch('/admin/overage-alerts/:alertId/handling', requireIdentity, requireMspAdmin(input.repo), async (req, res) => {
    if (!input.overageStore) return void res.status(503).json({ error: 'OVERAGE_MONITOR_UNAVAILABLE' });
    if (!/^\d+$/.test(req.params.alertId!)) return void res.status(400).json({ error: 'INVALID_REQUEST' });
    const parsed = overageHandlingSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'INVALID_REQUEST' });
    try {
      const updated = await input.overageStore.markInProgress(
        req.secureGuardUserId!, req.params.alertId!, parsed.data.responseChoice,
        parsed.data.responseNote || null,
      );
      if (!updated) return void res.status(404).json({ error: 'OVERAGE_ALERT_NOT_FOUND' });
      res.status(204).end();
    } catch { res.status(503).json({ error: 'OVERAGE_MONITOR_UNAVAILABLE' }); }
  });
  router.patch('/admin/organizations/:organizationId/license-allocation', requireIdentity, requireMspAdmin(input.repo), async (req, res) => {
    const parsed = licenseAllocationSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'INVALID_REQUEST' });
    try {
      const updated = await input.repo.updateLicenseAllocation(req.secureGuardUserId!, req.params.organizationId!, parsed.data.allocatedLicenses);
      if (!updated) return void res.status(404).json({ error: 'ORGANIZATION_OR_MAPPING_NOT_FOUND' });
      res.json({ allocation: { value: updated.allocatedLicenses, updatedAt: updated.licenseSnapshotUpdatedAt, source: 'dnsfilter_console_snapshot' } });
    } catch { res.status(500).json({ error: 'LICENSE_ALLOCATION_UNAVAILABLE' }); }
  });
  const licenseStatus = async (organizationId: string) => {
    const state = await input.repo.getLicenseAlertState(organizationId);
    if (!state) return null;
    try {
      const usage = await management().getOrganizationLicenseUsage(state.dnsfilterOrganizationId);
      const unknown = state.allocatedLicenses === null || usage.usage === null;
      const overage = unknown ? null : Math.max(0, usage.usage! - state.allocatedLicenses!);
      return {
        state,
        response: {
          allocation: { value: state.allocatedLicenses, updatedAt: state.licenseSnapshotUpdatedAt, source: 'dnsfilter_console_snapshot' },
          usage: { value: usage.usage, checkedAt: usage.checkedAt, source: 'dnsfilter_api_roaming_client_count' },
          status: unknown ? 'UNKNOWN' as const : overage! > 0 ? 'OVERAGE' as const : 'OK' as const,
          overage,
        },
      };
    } catch {
      return {
        state,
        response: {
          allocation: { value: state.allocatedLicenses, updatedAt: state.licenseSnapshotUpdatedAt, source: 'dnsfilter_console_snapshot' },
          usage: { value: null, checkedAt: new Date().toISOString(), source: 'dnsfilter_api_roaming_client_count' },
          status: 'UNKNOWN' as const,
          overage: null,
        },
      };
    }
  };
  router.get('/admin/organizations/:organizationId/license-status', requireIdentity, requireMspAdmin(input.repo), async (req, res) => {
    const result = await licenseStatus(req.params.organizationId!);
    if (!result) return void res.status(404).json({ error: 'ORGANIZATION_OR_MAPPING_NOT_FOUND' });
    res.json(result.response);
  });
  router.post('/admin/organizations/:organizationId/license-alerts/check', requireIdentity, requireMspAdmin(input.repo), async (req, res) => {
    const result = await licenseStatus(req.params.organizationId!);
    if (!result) return void res.status(404).json({ error: 'ORGANIZATION_OR_MAPPING_NOT_FOUND' });
    // A manual POST can read the current state but never claim, clear or send a second
    // Slack alert once the dedicated scheduled monitor owns alert delivery.
    if (input.manualLicenseAlertDeliveryEnabled === false) {
      return void res.json({ ...result.response, notification: 'managed_by_scheduled_monitor' });
    }
    if (result.response.status === 'UNKNOWN') return void res.json({ ...result.response, notification: 'not_sent_unknown' });
    if (result.response.status === 'OK') {
      await input.repo.clearResolvedLicenseAlert(req.params.organizationId!);
      return void res.json({ ...result.response, notification: 'not_needed' });
    }
    if (!input.licenseAlertSlack?.isConfigured()) return void res.json({ ...result.response, notification: 'not_configured' });
    const token = randomUUID();
    const claim = await input.repo.claimLicenseAlert(req.params.organizationId!, result.response.overage!, token);
    if (claim !== 'claimed') return void res.json({ ...result.response, notification: claim === 'duplicate' ? 'duplicate_suppressed' : 'pending' });
    const delivery = await input.licenseAlertSlack.send({ organizationName: result.state.organizationName, usage: result.response.usage.value!, allocation: result.response.allocation.value!, overage: result.response.overage!, checkedAt: result.response.usage.checkedAt, portalUrl: `${input.portalBaseUrl}/secure-guard-admin.html` });
    if (delivery !== 'sent') {
      await input.repo.failLicenseAlert(req.params.organizationId!, token);
      return void res.json({ ...result.response, notification: delivery });
    }
    if (!await input.repo.completeLicenseAlert(req.secureGuardUserId!, req.params.organizationId!, token)) return void res.status(409).json({ error: 'LICENSE_ALERT_STATE_CHANGED' });
    res.json({ ...result.response, notification: 'sent' });
  });
  router.get('/admin/organizations/:organizationId/memberships', requireIdentity, requireMspAdmin(input.repo), async (req, res) => {
    res.json({ memberships: await input.repo.listManagedMemberships(req.params.organizationId!) });
  });
  router.post('/admin/organizations/:organizationId/memberships/invitations', requireIdentity, requireMspAdmin(input.repo), async (req, res) => {
    const parsed = managedInvitationSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'INVALID_REQUEST' });
    try {
      const invitation = await input.identityService.createInvitation({ email: parsed.data.email, customerOrganizationId: req.params.organizationId!, role: parsed.data.role, invitedByUserId: req.secureGuardUserId! });
      await input.mailer.sendSecureGuardInvitationEmail(parsed.data.email, `${input.portalBaseUrl}/secure-guard-accept.html#token=${invitation.token}`);
      res.status(202).end();
    } catch (error) { if (!toError(error, res)) res.status(409).json({ error: 'MEMBERSHIP_CONFLICT' }); }
  });
  router.patch('/admin/organizations/:organizationId/memberships/:membershipId', requireIdentity, requireMspAdmin(input.repo), async (req, res) => {
    const parsed = roleUpdateSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'INVALID_REQUEST' });
    try { const ok = await input.repo.updateMembershipRole(req.secureGuardUserId!, req.params.organizationId!, req.params.membershipId!, parsed.data.role); if (!ok) return void res.status(404).json({ error: 'MEMBERSHIP_NOT_FOUND' }); res.status(204).end(); }
    catch (error) { if (!toError(error, res)) throw error; }
  });
  router.get('/admin/audit', requireIdentity, requireMspAdmin(input.repo), async (_req, res) => res.json({ events: await input.repo.listAuditEvents() }));
  router.get('/admin/dnsfilter/organizations', requireIdentity, requireMspAdmin(input.repo), async (_req, res) => {
    try { res.json({ organizations: await management().listOrganizations() }); } catch { res.status(502).json({ error: 'DNSFILTER_UNAVAILABLE' }); }
  });
  router.post('/admin/dnsfilter/organizations/sync', requireIdentity, requireMspAdmin(input.repo), async (req, res) => {
    // Complete the upstream read before any local write; do not accept arbitrary IDs from the client.
    if (req.body && (typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length > 0)) return void res.status(400).json({ error: 'INVALID_REQUEST' });
    let remote: Array<{ id: string; name: string }>;
    try { remote = await management().listOrganizations(); }
    catch { return void res.status(502).json({ error: 'DNSFILTER_ORGANIZATION_SYNC_UNAVAILABLE' }); }
    try { res.json(await synchronizeManagedOrganizations(input.repo, req.secureGuardUserId!, remote)); }
    catch { res.status(500).json({ error: 'ORGANIZATION_SYNC_OUTCOME_UNKNOWN' }); }
  });
  router.post('/admin/dnsfilter/organizations', requireIdentity, requireMspAdmin(input.repo), async (req, res) => {
    const parsed = provisioningSchema.safeParse(req.body); if (!parsed.success) return void res.status(400).json({ error: 'INVALID_REQUEST' });
    const draft = await input.repo.createProvisioningDraft(req.secureGuardUserId!, parsed.data.organizationName);
    try { const remote = await management().createOrganization(parsed.data.organizationName); const local = await input.repo.finalizeProvisioning(req.secureGuardUserId!, draft.id, remote.id); res.status(201).json(local); }
    catch (error) { await input.repo.recordSystemAudit(req.secureGuardUserId!, 'organization.provisioning.unresolved', 'failed').catch(() => undefined); res.status(error instanceof DnsFilterManagementError && error.code === 'DNSFILTER_UNAVAILABLE' ? 503 : 502).json({ error: 'DNSFILTER_CREATE_OUTCOME_UNKNOWN', organizationId: draft.id }); }
  });
  router.post('/admin/dnsfilter/organizations/import', requireIdentity, requireMspAdmin(input.repo), async (req, res) => {
    const parsed = importSchema.safeParse(req.body); if (!parsed.success) return void res.status(400).json({ error: 'INVALID_REQUEST' });
    try { const remote = await management().getOrganization(parsed.data.dnsfilterOrganizationId); const local = await input.repo.createManagedOrganization(req.secureGuardUserId!, parsed.data.organizationName, remote.id); res.status(201).json(local); }
    catch (error) { res.status(error instanceof DnsFilterManagementError ? 502 : 409).json({ error: error instanceof DnsFilterManagementError ? error.code : 'ORGANIZATION_CONFLICT' }); }
  });
  router.post('/admin/organizations/:organizationId/provisioning-recovery', requireIdentity, requireMspAdmin(input.repo), async (req, res) => {
    const parsed = recoverySchema.safeParse(req.body); if (!parsed.success) return void res.status(400).json({ error: 'INVALID_REQUEST' });
    try { const remote = await management().getOrganization(parsed.data.dnsfilterOrganizationId); const local = await input.repo.finalizeProvisioning(req.secureGuardUserId!, req.params.organizationId!, remote.id); if (!local) return void res.status(404).json({ error: 'ORGANIZATION_NOT_FOUND' }); res.json(local); }
    catch { res.status(502).json({ error: 'DNSFILTER_PROVISIONING_UNRESOLVED' }); }
  });
  router.get('/admin/organizations/:organizationId/policies', requireIdentity, requireMspAdmin(input.repo), async (req, res) => {
    const dnsId = await input.repo.findActiveDnsFilterOrganization(req.params.organizationId!); if (!dnsId) return void res.status(404).json({ error: 'DNSFILTER_MAPPING_NOT_FOUND' });
    try { res.json({ policies: await management().listPolicies(dnsId) }); } catch { res.status(502).json({ error: 'DNSFILTER_UNAVAILABLE' }); }
  });
  router.get('/admin/organizations/:organizationId/sites', requireIdentity, requireMspAdmin(input.repo), async (req, res) => {
    const dnsId = await input.repo.findActiveDnsFilterOrganization(req.params.organizationId!); if (!dnsId) return void res.status(404).json({ error: 'DNSFILTER_MAPPING_NOT_FOUND' });
    try { res.json({ sites: await management().listNetworks(dnsId) }); } catch { res.status(502).json({ error: 'DNSFILTER_UNAVAILABLE' }); }
  });
  router.post('/admin/organizations/:organizationId/sites', requireIdentity, requireMspAdmin(input.repo), async (req, res) => {
    const parsed = networkSchema.safeParse(req.body); if (!parsed.success) return void res.status(400).json({ error: 'INVALID_REQUEST' });
    const dnsId = await input.repo.findActiveDnsFilterOrganization(req.params.organizationId!); if (!dnsId) return void res.status(404).json({ error: 'DNSFILTER_MAPPING_NOT_FOUND' });
    try {
      const site = await management().createNetwork(dnsId, parsed.data);
      await input.repo.recordSystemAudit(req.secureGuardUserId!, 'site.created', 'success');
      res.status(201).json(site);
    } catch {
      // A remote Site may exist despite a failed response/read-back. Do not advise re-POST.
      await input.repo.recordSystemAudit(req.secureGuardUserId!, 'site.creation.unresolved', 'failed').catch(() => undefined);
      res.status(502).json({ error: 'DNSFILTER_SITE_CREATE_OUTCOME_UNKNOWN' });
    }
  });

  router.get('/overview', requireIdentity, requireCustomerScope, async (req, res) => {
    const scope = req.secureGuardScope!;
    const inventory = await loadInventory(scope.customerOrganizationId);
    if (!inventory) {
      res.status(502).json({ error: 'SECURE_GUARD_DATA_UNAVAILABLE' });
      return;
    }
    const protection = inventory.agents.reduce<Record<string, number>>((summary, agent) => {
      const key = `${agent.status}/${agent.agentState}`;
      summary[key] = (summary[key] ?? 0) + 1;
      return summary;
    }, {});
    res.json({
      organization: { name: scope.organizationName },
      scope: { membershipId: scope.membershipId, role: scope.role },
      capabilities: { agentQueuedUninstall: agentUninstallReady && (scope.role === 'org_admin' || scope.role === 'operator') },
      fetchedAt: inventory.fetchedAt,
      siteCount: inventory.sites.length,
      agentCount: inventory.agents.length,
      protection,
      sites: inventory.sites,
      agents: inventory.agents,
    });
  });

  router.get('/sites', requireIdentity, requireCustomerScope, async (req, res) => {
    const inventory = await loadInventory(req.secureGuardScope!.customerOrganizationId);
    if (!inventory) {
      res.status(502).json({ error: 'SECURE_GUARD_DATA_UNAVAILABLE' });
      return;
    }
    res.json({ fetchedAt: inventory.fetchedAt, sites: inventory.sites });
  });

  router.get('/agents', requireIdentity, requireCustomerScope, async (req, res) => {
    const inventory = await loadInventory(req.secureGuardScope!.customerOrganizationId);
    if (!inventory) {
      res.status(502).json({ error: 'SECURE_GUARD_DATA_UNAVAILABLE' });
      return;
    }
    res.json({ fetchedAt: inventory.fetchedAt, agents: inventory.agents });
  });

  router.get('/agents/:agentId/uninstall-status', requireIdentity, requireCustomerScope, async (req, res) => {
    const parsed = agentUuidSchema.safeParse(req.params.agentId);
    if (!parsed.success) return void res.status(400).json({ error: 'INVALID_AGENT_ID' });
    try {
      const claim = await input.repo.getAgentUninstallClaim(req.secureGuardScope!.customerOrganizationId, parsed.data);
      res.json({ claim });
    } catch { res.status(503).json({ error: 'AGENT_UNINSTALL_STATUS_UNAVAILABLE' }); }
  });

  router.post('/agents/:agentId/queued-uninstall', requireIdentity, requireCustomerScope, async (req, res) => {
    if (!agentUninstallReady) return void res.status(503).json({ error: 'AGENT_UNINSTALL_NOT_ENABLED' });
    const scope = req.secureGuardScope!;
    if (scope.role !== 'org_admin' && scope.role !== 'operator') return void res.status(403).json({ error: 'CUSTOMER_SCOPE_DENIED' });
    const agentId = agentUuidSchema.safeParse(req.params.agentId);
    const body = agentUninstallSchema.safeParse(req.body);
    if (!agentId.success || !body.success || body.data.hostname !== body.data.confirmHostname) {
      return void res.status(400).json({ error: 'AGENT_CONFIRMATION_MISMATCH' });
    }
    let dnsfilterOrganizationId: string | null;
    let inventory: SecureGuardInventory;
    try {
      dnsfilterOrganizationId = await input.repo.findActiveDnsFilterOrganization(scope.customerOrganizationId);
      if (!dnsfilterOrganizationId) return void res.status(409).json({ error: 'AGENT_SCOPE_UNAVAILABLE' });
      // Fresh complete cross-source inventory; never trust an Agent UUID, Site or hostname from a browser alone.
      inventory = await input.inventoryClient.getInventory(dnsfilterOrganizationId);
    } catch { return void res.status(503).json({ error: 'AGENT_PREFLIGHT_UNAVAILABLE' }); }
    const matches = inventory.agents.filter((agent) => agent.id.toLowerCase() === agentId.data.toLowerCase());
    if (matches.length !== 1 || matches[0]!.siteId !== body.data.siteId || matches[0]!.hostname !== body.data.hostname
      || !inventory.sites.some((site) => site.id === body.data.siteId)) {
      return void res.status(409).json({ error: 'AGENT_TARGET_CHANGED_REFRESH_REQUIRED' });
    }
    const operationId = randomUUID();
    try {
      const claim = await input.repo.claimAgentUninstall({ operationId, actorUserId: req.secureGuardUserId!,
        scope, dnsfilterOrganizationId, agentUuid: agentId.data, siteId: body.data.siteId, hostname: body.data.hostname });
      if (claim === 'denied') return void res.status(403).json({ error: 'CUSTOMER_SCOPE_DENIED' });
      if (claim === 'duplicate') return void res.status(409).json({ error: 'AGENT_UNINSTALL_ALREADY_CLAIMED_NO_RETRY' });
    } catch {
      // No committed claim -> no HTTP DELETE. A DB COMMIT acknowledgement may itself be ambiguous:
      // fail closed; later calls can only proceed if no claim exists, never blindly replay here.
      return void res.status(503).json({ error: 'AGENT_UNINSTALL_CLAIM_UNAVAILABLE_NO_RETRY' });
    }
    try {
      await input.agentUninstallClient!.requestQueuedUninstall(agentId.data);
      const recorded = await input.repo.finishAgentUninstall(operationId, req.secureGuardUserId!, scope, 'accepted');
      if (!recorded) throw new Error('AGENT_UNINSTALL_RECORD_NOT_CONFIRMED');
      return void res.status(202).json({ operationId, status: 'accepted', deviceUninstallCompleted: false });
    } catch {
      // Claim remains forever: 204 response loss, API failure, timeout and DB failure all mean NO RETRY.
      await input.repo.finishAgentUninstall(operationId, req.secureGuardUserId!, scope, 'unknown').catch(() => undefined);
      return void res.status(503).json({ error: 'AGENT_UNINSTALL_OUTCOME_UNKNOWN_NO_RETRY', operationId });
    }
  });

  router.get('/memberships', requireIdentity, requireCustomerScope, async (req, res) => {
    res.json({ memberships: await input.repo.listManagedMemberships(req.secureGuardScope!.customerOrganizationId) });
  });

  router.post('/memberships/invitations', requireIdentity, requireCustomerScope, async (req, res) => {
    if (req.secureGuardScope!.role !== 'org_admin') {
      res.status(403).json({ error: 'CUSTOMER_SCOPE_DENIED' });
      return;
    }
    const parsed = invitationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_REQUEST' });
      return;
    }
    try {
      const invitation = await input.identityService.createInvitation({
        email: parsed.data.email,
        customerOrganizationId: req.secureGuardScope!.customerOrganizationId,
        role: parsed.data.role,
        invitedByUserId: req.secureGuardUserId!,
      });
      const acceptUrl = `${input.portalBaseUrl}/secure-guard-accept.html#token=${invitation.token}`;
      await input.mailer.sendSecureGuardInvitationEmail(parsed.data.email, acceptUrl);
      res.status(202).end();
    } catch (error) {
      if (!toError(error, res)) throw error;
    }
  });

  router.post('/memberships/:membershipId/revoke', requireIdentity, requireCustomerScope, async (req, res) => {
    if (req.secureGuardScope!.role !== 'org_admin') {
      res.status(403).json({ error: 'CUSTOMER_SCOPE_DENIED' });
      return;
    }
    const membershipId = req.params.membershipId;
    if (!membershipId) {
      res.status(400).json({ error: 'INVALID_REQUEST' });
      return;
    }
    try {
      const revoked = await input.repo.revokeMembership(
        req.secureGuardUserId!,
        req.secureGuardScope!,
        membershipId,
      );
      if (!revoked) {
        res.status(404).json({ error: 'MEMBERSHIP_NOT_FOUND' });
        return;
      }
      res.status(204).end();
    } catch (error) {
      if (!toError(error, res)) throw error;
    }
  });

  router.patch('/memberships/:membershipId', requireIdentity, requireCustomerScope, async (req, res) => {
    if (req.secureGuardScope!.role !== 'org_admin') return void res.status(403).json({ error: 'CUSTOMER_SCOPE_DENIED' });
    const parsed = roleUpdateSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'INVALID_REQUEST' });
    try { const ok = await input.repo.updateMembershipRole(req.secureGuardUserId!, req.secureGuardScope!.customerOrganizationId, req.params.membershipId!, parsed.data.role); if (!ok) return void res.status(404).json({ error: 'MEMBERSHIP_NOT_FOUND' }); res.status(204).end(); }
    catch (error) { if (!toError(error, res)) throw error; }
  });

  // The initial administrator is never created by a migration or ordinary customer request.
  // An explicitly provisioned MSP administrator may issue exactly one first invitation per organization.
  router.post('/admin/initial-memberships/invitations', requireIdentity, requireMspAdmin(input.repo), async (req, res) => {
    const parsed = initialInvitationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_REQUEST' });
      return;
    }
    try {
      const invitation = await input.identityService.createInvitation({
        email: parsed.data.email,
        customerOrganizationId: parsed.data.customerOrganizationId,
        role: 'org_admin' as CustomerRole,
        invitedByUserId: req.secureGuardUserId!,
        initialOnly: true,
      });
      const acceptUrl = `${input.portalBaseUrl}/secure-guard-accept.html#token=${invitation.token}`;
      try {
        await input.mailer.sendSecureGuardInvitationEmail(parsed.data.email, acceptUrl);
      } catch {
        // The token stays pending and is not automatically resent. An MSP administrator must explicitly cancel or reissue it.
        res.status(503).json({ error: 'INVITATION_DELIVERY_UNCONFIRMED' });
        return;
      }
      res.status(202).end();
    } catch (error) {
      if (!toError(error, res)) throw error;
    }
  });

  router.post('/admin/initial-memberships/invitations/cancel', requireIdentity, requireMspAdmin(input.repo), async (req, res) => {
    const parsed = initialInvitationCancelSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_REQUEST' });
      return;
    }
    try {
      const cancelled = await input.repo.cancelInitialInvitation(
        req.secureGuardUserId!,
        parsed.data.customerOrganizationId,
      );
      if (!cancelled) {
        res.status(404).json({ error: 'INITIAL_ADMIN_INVITATION_NOT_FOUND' });
        return;
      }
      res.status(204).end();
    } catch (error) {
      if (!toError(error, res)) throw error;
    }
  });

  router.post('/admin/initial-memberships/invitations/reissue', requireIdentity, requireMspAdmin(input.repo), async (req, res) => {
    const parsed = initialInvitationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_REQUEST' });
      return;
    }
    try {
      const invitation = await input.identityService.replaceInitialInvitation({
        email: parsed.data.email,
        customerOrganizationId: parsed.data.customerOrganizationId,
        invitedByUserId: req.secureGuardUserId!,
      });
      const acceptUrl = `${input.portalBaseUrl}/secure-guard-accept.html#token=${invitation.token}`;
      try {
        await input.mailer.sendSecureGuardInvitationEmail(parsed.data.email, acceptUrl);
      } catch {
        // Reissue commits exactly one new pending token before delivery. The operator must decide whether to cancel or reissue again.
        res.status(503).json({ error: 'INVITATION_DELIVERY_UNCONFIRMED' });
        return;
      }
      res.status(202).end();
    } catch (error) {
      if (!toError(error, res)) throw error;
    }
  });

  return router;
}
