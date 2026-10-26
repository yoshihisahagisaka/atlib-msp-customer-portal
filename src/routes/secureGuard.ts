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

const membershipRoleSchema = z.enum(['org_admin', 'operator', 'viewer']);
const invitationSchema = z.object({ email: z.string().email(), role: membershipRoleSchema });
const initialInvitationSchema = z.object({
  customerOrganizationId: z.string().uuid(),
  email: z.string().email(),
});

function toError(error: unknown, res: { status: (code: number) => { json: (value: unknown) => void } }): boolean {
  if (!(error instanceof SecureGuardConflictError)) return false;
  const status = error.code === 'LAST_ORG_ADMIN' ? 409 : 409;
  res.status(status).json({ error: error.code });
  return true;
}

export function createSecureGuardRouter(input: {
  identityService: SecureGuardIdentityService;
  repo: SecureGuardRepo;
  mailer: Mailer;
  portalBaseUrl: string;
}): Router {
  const router = Router();
  const requireIdentity = requireSecureGuardIdentity(input.identityService);
  const requireCustomerScope = requireSecureGuardCustomerScope(input.repo);

  router.get('/me', requireIdentity, async (req, res) => {
    const memberships = await input.repo.listActiveMemberships(req.secureGuardUserId!);
    const mspAdmin = await input.repo.hasActiveMspAdminGrant(req.secureGuardUserId!);
    res.json({ memberships, mspAdmin });
  });

  router.get('/overview', requireIdentity, requireCustomerScope, (req, res) => {
    const scope = req.secureGuardScope!;
    // C2 receipts and inventory projections are deliberately out of this first phase.
    res.json({
      organization: { name: scope.organizationName },
      scope: { membershipId: scope.membershipId, role: scope.role },
      observation: null,
    });
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
      await input.mailer.sendSecureGuardInvitationEmail(parsed.data.email, acceptUrl);
      res.status(202).end();
    } catch (error) {
      if (!toError(error, res)) throw error;
    }
  });

  return router;
}
