import { Router } from 'express';
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
import type { SecureGuardInventory } from '../domain/secureGuardInventory';
import { DnsFilterManagementClient, DnsFilterManagementError } from '../services/dnsFilterManagementClient';

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
const networkSchema = z.object({ name: z.string().trim().min(1).max(255), policyIds: z.array(z.string().regex(/^\d+$/)).max(10) });

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
}): Router {
  const router = Router();
  const requireIdentity = requireSecureGuardIdentity(input.identityService);
  const requireCustomerScope = requireSecureGuardCustomerScope(input.repo);
  const management = () => { if (!input.managementClient) throw new DnsFilterManagementError('DNSFILTER_UNAVAILABLE'); return input.managementClient; };

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
  router.get('/admin/organizations/:organizationId/policies', requireIdentity, requireMspAdmin(input.repo), async (req, res) => {
    const dnsId = await input.repo.findActiveDnsFilterOrganization(req.params.organizationId!); if (!dnsId) return void res.status(404).json({ error: 'DNSFILTER_MAPPING_NOT_FOUND' });
    try { res.json({ policies: await management().listPolicies(dnsId) }); } catch { res.status(502).json({ error: 'DNSFILTER_UNAVAILABLE' }); }
  });
  router.post('/admin/organizations/:organizationId/sites', requireIdentity, requireMspAdmin(input.repo), async (req, res) => {
    const parsed = networkSchema.safeParse(req.body); if (!parsed.success) return void res.status(400).json({ error: 'INVALID_REQUEST' });
    const dnsId = await input.repo.findActiveDnsFilterOrganization(req.params.organizationId!); if (!dnsId) return void res.status(404).json({ error: 'DNSFILTER_MAPPING_NOT_FOUND' });
    try { const site = await management().createNetwork(dnsId, parsed.data.name, parsed.data.policyIds); await input.repo.recordSystemAudit(req.secureGuardUserId!, 'site.created', 'success'); res.status(201).json(site); } catch { res.status(502).json({ error: 'DNSFILTER_SITE_CREATE_UNAVAILABLE' }); }
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
