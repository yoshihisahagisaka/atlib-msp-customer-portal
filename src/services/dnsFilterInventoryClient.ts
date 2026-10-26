import type { SecureGuardAgent, SecureGuardInventory, SecureGuardSite } from '../domain/secureGuardInventory';

const API_ROOT = 'https://api.dnsfilter.com';
const PAGING_KEYS = new Set(['page', 'per_page', 'page_size', 'page[number]', 'page[size]', 'offset', 'limit', 'cursor']);

export class DnsFilterInventoryError extends Error {
  constructor() { super('DNSFILTER_INVENTORY_UNAVAILABLE'); }
}

export interface DnsFilterResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type DnsFilterFetch = (url: string, init: { method: 'GET'; headers: Record<string, string> }) => Promise<DnsFilterResponse>;

type RecordValue = Record<string, unknown>;

function fail(): never { throw new DnsFilterInventoryError(); }
function object(value: unknown): RecordValue { if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(); return value as RecordValue; }
function text(value: unknown): string { if (typeof value !== 'string' && typeof value !== 'number') fail(); const result = String(value); if (!result) fail(); return result; }

function relation(item: unknown, name: string): string {
  const resource = object(item);
  const relationships = object(resource.relationships ?? {});
  const relationship = object(relationships[name] ?? {});
  const data = object(relationship.data ?? {});
  const attributes = object(resource.attributes ?? {});
  const values = [data.id, relationship.id, attributes[`${name}_id`]]
    .filter((value) => value !== null && value !== undefined && String(value) !== '')
    .map((value) => text(value));
  const unique = [...new Set(values)];
  if (unique.length !== 1) fail();
  return unique[0]!;
}

interface Pages { rows: unknown[]; }

/** GET-only, fail-closed DNSFilter inventory client. It exposes no arbitrary URL or query API. */
export class DnsFilterInventoryClient {
  constructor(private readonly apiKey: string | undefined, private readonly fetcher: DnsFilterFetch = fetch as unknown as DnsFilterFetch) {}

  async getInventory(organizationId: string): Promise<SecureGuardInventory> {
    if (!this.apiKey || !/^\d+$/.test(organizationId)) fail();
    const sitesPage = await this.pages(`/v1/networks?organization_id=${encodeURIComponent(organizationId)}`, '/v1/networks', { organization_id: organizationId });
    const sites: Array<SecureGuardSite & { rawId: string }> = [];
    const scopedAgents: SecureGuardAgent[] = [];
    const seenAgentIds = new Set<string>();

    for (const rawSite of sitesPage.rows) {
      if (relation(rawSite, 'organization') !== organizationId) fail();
      const resource = object(rawSite);
      const rawId = text(resource.id);
      const attributes = object(resource.attributes);
      const name = text(attributes.name);
      const siteAgents = await this.pages(
        `/v1/user_agents?organization_ids=${encodeURIComponent(organizationId)}&network_ids=${encodeURIComponent(rawId)}`,
        '/v1/user_agents',
        { organization_ids: organizationId, network_ids: rawId },
      );
      let agentCount = 0;
      for (const rawAgent of siteAgents.rows) {
        const agent = this.agent(rawAgent, organizationId, rawId);
        if (seenAgentIds.has(agent.id.toLowerCase())) fail();
        seenAgentIds.add(agent.id.toLowerCase());
        scopedAgents.push(agent);
        agentCount += 1;
      }
      sites.push({ rawId, id: rawId, name, agentCount, policy: null });
    }

    const organizationAgents = await this.pages(
      `/v1/user_agents?organization_ids=${encodeURIComponent(organizationId)}`,
      '/v1/user_agents',
      { organization_ids: organizationId },
    );
    const allAgents = organizationAgents.rows.map((row) => this.agent(row, organizationId));
    const fingerprint = (agents: SecureGuardAgent[]) => JSON.stringify([...agents].map((agent) => `${agent.id}\u0000${agent.siteId}\u0000${agent.hostname}\u0000${agent.status}\u0000${agent.agentState}`).sort());
    if (fingerprint(scopedAgents) !== fingerprint(allAgents)) fail();

    const siteIds = new Set(sites.map((site) => site.rawId.toLowerCase()));
    if (allAgents.some((agent) => !siteIds.has(agent.siteId.toLowerCase()))) fail();
    return {
      fetchedAt: new Date().toISOString(),
      sites: sites.map(({ rawId: _rawId, ...site }) => site).sort((a, b) => a.name.localeCompare(b.name, 'ja')),
      agents: allAgents.sort((a, b) => a.hostname.localeCompare(b.hostname, 'ja')),
    };
  }

  private agent(value: unknown, organizationId: string, expectedSiteId?: string): SecureGuardAgent {
    if (relation(value, 'organization') !== organizationId) fail();
    const siteId = relation(value, 'network');
    if (expectedSiteId && siteId !== expectedSiteId) fail();
    const resource = object(value);
    const attributes = object(resource.attributes);
    return { id: text(resource.id), hostname: text(attributes.hostname), siteId, status: text(attributes.status), agentState: text(attributes.agent_state) };
  }

  private async pages(initial: string, path: string, scope: Record<string, string>): Promise<Pages> {
    let next: string | null = initial;
    const seenUrls = new Set<string>();
    const seenIds = new Set<string>();
    const rows: unknown[] = [];
    let totalPresence: boolean | undefined;
    let expectedTotal: number | undefined;
    while (next !== null) {
      let url: URL;
      try { url = new URL(next, API_ROOT); } catch { fail(); }
      if (url.protocol !== 'https:' || url.hostname !== 'api.dnsfilter.com' || url.port || url.username || url.password || url.hash || url.pathname !== path || seenUrls.has(url.href) || seenUrls.size >= 10000) fail();
      const actual = new Map<string, string>();
      for (const [key, value] of url.searchParams) {
        if (actual.has(key) || (!(key in scope) && !PAGING_KEYS.has(key))) fail();
        actual.set(key, value);
      }
      if (Object.entries(scope).some(([key, value]) => actual.get(key) !== value)) fail();
      seenUrls.add(url.href);
      const response = await this.fetcher(url.href, { method: 'GET', headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' } });
      if (!response.ok || response.status !== 200) fail();
      let body: RecordValue;
      try { body = object(await response.json()); } catch { fail(); }
      if (!Array.isArray(body.data) || !object(body.links) || !Object.hasOwn(object(body.links), 'next')) fail();
      const hasTotal = Object.hasOwn(object(body.meta ?? {}), 'total_count');
      if (totalPresence === undefined) totalPresence = hasTotal;
      else if (totalPresence !== hasTotal) fail();
      if (hasTotal) {
        const value = text(object(body.meta).total_count);
        if (!/^\+?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) fail();
        if (expectedTotal === undefined) expectedTotal = Number(value);
        else if (expectedTotal !== Number(value)) fail();
      }
      for (const row of body.data) {
        const id = text(object(row).id).toLowerCase();
        if (seenIds.has(id)) fail();
        seenIds.add(id);
        rows.push(row);
      }
      const nextLink = object(body.links).next;
      if (nextLink !== null && typeof nextLink !== 'string') fail();
      if (nextLink === '') fail();
      next = nextLink;
    }
    if (expectedTotal !== undefined && expectedTotal !== rows.length) fail();
    return { rows };
  }
}
