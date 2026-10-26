export type CustomerRole = 'org_admin' | 'operator' | 'viewer';
export type MembershipStatus = 'pending' | 'active' | 'revoked';
export type MspRole = 'msp_admin';

export interface SecureGuardSessionPayload {
  userId: string;
  sessionVersion: number;
}

export interface CustomerScope {
  membershipId: string;
  customerOrganizationId: string;
  organizationName: string;
  role: CustomerRole;
}

export const CUSTOMER_ROLES: readonly CustomerRole[] = ['org_admin', 'operator', 'viewer'];
