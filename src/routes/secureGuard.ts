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

const membershipRoleSchema = z.enum(['org_admin', 'operator', 'viewer']);
const invitationSchema = z.object({ email: z.string().email(), role: membershipRoleSchema });
const initialInvitationSchema = z.object({
  customerOrganizationId: z.string().uuid(),
  email: z.string().email(),
});
const initialInvitationCancelSchema = z.object({ customerOrganizationId: z.string().uuid() });

function toError(error: unknown, res: { status: (code: number) => { json: (value: unknown) => void } }): boolean {
  if (!(error instanceof SecureGuardConflictError)) return false;
  const status = error.code === 'LAST_ORG_ADMIN' ? 409 : 409;
  res.status(status).json({ error: error.code });
  return true;
}

export function createSecureGuardRouter(input: {
  identityService: SecureGuardIdentityService;
  repo: SecureGuardRepo;
  inventoryClient: DnsFilterInventoryClient;
  mailer: Mailer;
  portalBaseUrl: string;
}): Router {
  const router = Router();
  const requireIdentity = requireSecureGuardIdentity(input.identityService);
  const requireCustomerScope = requireSecureGuardCustomerScope(input.repo);

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
