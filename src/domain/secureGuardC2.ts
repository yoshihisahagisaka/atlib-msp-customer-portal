/** Customer-safe representation of a C2 DryRun receipt. No DNSFilter identifier is exposed. */
export interface SecureGuardC2Overview {
  observedAt: string;
  completedAt: string;
  sourceSha: string;
  planHash: string;
  generation: string;
  mode: 'DryRun';
  mutations: 0;
  siteCount: number;
  agentCount: number;
}

export interface SecureGuardC2SiteProjection {
  displayOrder: number;
  agentCount: number;
}

export interface SecureGuardC2AgentProjection {
  displayOrder: number;
  siteDisplayOrder: number;
  status: string;
  agentState: string;
}

export interface SecureGuardC2Projection extends SecureGuardC2Overview {
  sites: SecureGuardC2SiteProjection[];
  agents: SecureGuardC2AgentProjection[];
}
