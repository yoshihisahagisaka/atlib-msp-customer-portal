export interface SecureGuardSite {
  id: string;
  name: string;
  agentCount: number;
  // No verified Network policy field was established by the PoC; never infer one.
  policy: null;
}

export interface SecureGuardAgent {
  id: string;
  hostname: string;
  siteId: string;
  status: string;
  agentState: string;
}

export interface SecureGuardInventory {
  fetchedAt: string;
  sites: SecureGuardSite[];
  agents: SecureGuardAgent[];
}
