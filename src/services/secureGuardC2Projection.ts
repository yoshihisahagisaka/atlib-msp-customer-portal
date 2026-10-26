import { createHash } from 'crypto';
import type { SecureGuardC2Projection } from '../domain/secureGuardC2';

type ObjectRecord = Record<string, unknown>;

export class C2ProjectionVerificationError extends Error {
  constructor() {
    super('C2_PROJECTION_UNVERIFIED');
  }
}

export interface C2ReceiptCandidate {
  plan: unknown;
  gcsObject: string;
  generation: string;
  observedAt: string;
  completedAt: string;
}

function fail(): never {
  throw new C2ProjectionVerificationError();
}

function object(value: unknown): ObjectRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as ObjectRecord;
}

function exactKeys(value: unknown, expected: readonly string[]): ObjectRecord {
  const candidate = object(value);
  const actual = Object.keys(candidate);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) fail();
  return candidate;
}

function text(value: unknown): string {
  if (typeof value !== 'string') fail();
  return value;
}

function nonEmptyText(value: unknown): string {
  const result = text(value);
  if (!result) fail();
  return result;
}

function safeLabel(value: unknown): string {
  const result = nonEmptyText(value);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(result)) fail();
  return result;
}

function nonNegativeInteger(value: unknown, positive = false): number {
  if ((typeof value !== 'number' && !/^\d+$/.test(String(value))) || !/^\d+$/.test(String(value))) fail();
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < (positive ? 1 : 0)) fail();
  return result;
}

function validTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) fail();
  return value;
}

function orderedJson(value: unknown): string {
  const visit = (current: unknown): string => {
    if (current === null) return 'null';
    if (typeof current === 'string') return JSON.stringify(current).replace(/[\u0085\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
    if (typeof current === 'boolean') return current ? 'true' : 'false';
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) fail();
      return JSON.stringify(current).replace(/e([+-]?)(\d+)$/, (_match, sign: string, digits: string) => `E${sign === '-' ? '-' : '+'}${digits.padStart(2, '0')}`);
    }
    if (Array.isArray(current)) return `[${current.map((item) => visit(item === undefined ? null : item)).join(',')}]`;
    if (current !== null && typeof current === 'object') {
      return `{${Object.entries(current).filter(([, item]) => item !== undefined).map(([key, item]) => `${JSON.stringify(key)}:${visit(item)}`).join(',')}}`;
    }
    fail();
  };
  return visit(value);
}

function hashOrdered(value: unknown): string {
  return createHash('sha256').update(orderedJson(value), 'utf8').digest('hex');
}

/**
 * Verifies the C2 canonical plan shape before deriving the intentionally lossy customer view.
 * The caller supplies the DNSFilter organization only from its server-side mapping, never a request value.
 */
export function verifyAndProjectC2Receipt(candidate: C2ReceiptCandidate, dnsfilterOrganizationId: string): SecureGuardC2Projection {
  if (!/^\d+$/.test(dnsfilterOrganizationId)) fail();
  if (!/^[1-9][0-9]*$/.test(candidate.generation)) fail();
  const observedAt = validTimestamp(candidate.observedAt);
  const completedAt = validTimestamp(candidate.completedAt);

  const plan = exactKeys(candidate.plan, ['plan_hash', 'payload']);
  const planHash = text(plan.plan_hash);
  if (!/^[a-f0-9]{64}$/.test(planHash)) fail();
  const payload = exactKeys(plan.payload, ['source_sha', 'mode', 'inventory', 'mutations_enabled']);
  const sourceSha = text(payload.source_sha);
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || payload.mode !== 'DryRun' || payload.mutations_enabled !== false) fail();
  const inventory = exactKeys(payload.inventory, ['organization_id', 'msp_parent_id', 'sites', 'agents', 'paging', 'visibility']);
  if (inventory.organization_id !== dnsfilterOrganizationId || !/^\d+$/.test(text(inventory.msp_parent_id))) fail();
  if (!Array.isArray(inventory.sites) || !Array.isArray(inventory.agents)) fail();

  const siteIds = new Set<string>();
  const sites = inventory.sites.map((rawSite, index) => {
    const site = exactKeys(rawSite, ['id', 'name', 'organization_id']);
    const id = nonEmptyText(site.id);
    if (site.organization_id !== dnsfilterOrganizationId || siteIds.has(id.toLowerCase())) fail();
    siteIds.add(id.toLowerCase());
    // The ID and name participate in hash verification but are deliberately discarded.
    nonEmptyText(site.name);
    return { id, displayOrder: index + 1 };
  });

  const agentIds = new Set<string>();
  const agents = inventory.agents.map((rawAgent, index) => {
    const agent = exactKeys(rawAgent, ['uuid', 'hostname', 'organization_id', 'site_id', 'status', 'agent_state']);
    const uuid = nonEmptyText(agent.uuid);
    const siteId = nonEmptyText(agent.site_id);
    if (agent.organization_id !== dnsfilterOrganizationId || !siteIds.has(siteId.toLowerCase()) || agentIds.has(uuid.toLowerCase())) fail();
    agentIds.add(uuid.toLowerCase());
    // UUID and hostname are validated for canonical hashing but never included in the projection.
    nonEmptyText(agent.hostname);
    return { displayOrder: index + 1, siteId, status: safeLabel(agent.status), agentState: safeLabel(agent.agent_state) };
  });

  const paging = exactKeys(inventory.paging, ['site_pages', 'site_total', 'org_agent_pages', 'org_agent_total', 'per_site']);
  const siteTotal = nonNegativeInteger(paging.site_total);
  const agentTotal = nonNegativeInteger(paging.org_agent_total);
  if (siteTotal !== sites.length || agentTotal !== agents.length || !Array.isArray(paging.per_site)) fail();
  // Validate the complete C2 paging contract before treating its data as a verified receipt.
  for (const field of ['site_pages', 'org_agent_pages']) nonNegativeInteger(paging[field]);
  if (paging.per_site.length !== sites.length) fail();
  const proofSiteIds = new Set<string>();
  for (const rawProof of paging.per_site) {
    const proof = exactKeys(rawProof, ['scope', 'site_id', 'pages', 'total', 'proof']);
    const siteId = nonEmptyText(proof.site_id);
    const total = nonNegativeInteger(proof.total);
    nonNegativeInteger(proof.pages, true);
    if (
      proof.scope !== 'site'
      || !siteIds.has(siteId.toLowerCase())
      || proofSiteIds.has(siteId.toLowerCase())
      || !['explicit-next-null+stable-total_count+unique-ids', 'explicit-next-null+unique-ids'].includes(text(proof.proof))
      || agents.filter((agent) => agent.siteId === siteId).length !== total
    ) fail();
    proofSiteIds.add(siteId.toLowerCase());
  }
  if (inventory.visibility !== 'API default documented collection only; relay/deleted visibility requires review') fail();

  const canonicalPayload = {
    source_sha: sourceSha,
    mode: 'DryRun',
    inventory: {
      organization_id: dnsfilterOrganizationId,
      msp_parent_id: text(inventory.msp_parent_id),
      sites: inventory.sites,
      agents: inventory.agents,
      paging: inventory.paging,
      visibility: inventory.visibility,
    },
    mutations_enabled: false,
  };
  if (hashOrdered(canonicalPayload) !== planHash || hashOrdered(payload) !== planHash) fail();
  const expectedObjectPath = `/dryruns/organizations/${dnsfilterOrganizationId}/plans/${planHash}.json`;
  if (!/^gs:\/\/[^/]+\/.+/.test(candidate.gcsObject) || !candidate.gcsObject.endsWith(expectedObjectPath)) fail();

  const siteIndex = new Map(sites.map((site) => [site.id.toLowerCase(), site.displayOrder]));
  return {
    observedAt,
    completedAt,
    sourceSha,
    planHash,
    generation: candidate.generation,
    mode: 'DryRun',
    mutations: 0,
    siteCount: sites.length,
    agentCount: agents.length,
    sites: sites.map((site) => ({
      displayOrder: site.displayOrder,
      agentCount: agents.filter((agent) => agent.siteId.toLowerCase() === site.id.toLowerCase()).length,
    })),
    agents: agents.map((agent) => ({
      displayOrder: agent.displayOrder,
      siteDisplayOrder: siteIndex.get(agent.siteId.toLowerCase())!,
      status: agent.status,
      agentState: agent.agentState,
    })),
  };
}
