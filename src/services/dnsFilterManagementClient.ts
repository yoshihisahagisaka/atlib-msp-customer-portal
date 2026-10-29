import { getSecret } from '../lib/secrets';

type Json = Record<string, unknown>;
export class DnsFilterManagementError extends Error { constructor(readonly code: 'DNSFILTER_UNAVAILABLE' | 'DNSFILTER_CREATE_OUTCOME_UNKNOWN' | 'DNSFILTER_SHAPE_UNKNOWN') { super(code); } }
function object(v: unknown): Json { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new DnsFilterManagementError('DNSFILTER_SHAPE_UNKNOWN'); return v as Json; }
function id(v: unknown): string { if (typeof v !== 'string' && typeof v !== 'number') throw new DnsFilterManagementError('DNSFILTER_SHAPE_UNKNOWN'); const x = String(v); if (!/^\d+$/.test(x)) throw new DnsFilterManagementError('DNSFILTER_SHAPE_UNKNOWN'); return x; }

/** Narrow MSP client: only documented Organization/Network creation and read paths. No delete, agent, or key lifecycle calls. */
export class DnsFilterManagementClient {
  constructor(private readonly projectId: string, private readonly mspId: string | undefined, private readonly key = () => process.env.DNSFILTER_API_KEY ?? getSecret(projectId, 'secure-guard-dnsfilter-api-key'), private readonly fetcher: typeof fetch = fetch) {}
  private async request(path: string, init: RequestInit): Promise<Json> {
    if (!this.mspId || !/^\d+$/.test(this.mspId)) throw new DnsFilterManagementError('DNSFILTER_UNAVAILABLE');
    let key: string; try { key = await this.key(); } catch { throw new DnsFilterManagementError('DNSFILTER_UNAVAILABLE'); }
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8_000);
    let response: Response; try { response = await this.fetcher(`https://api.dnsfilter.com${path}`, { ...init, signal: controller.signal, headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) } }); } catch { throw new DnsFilterManagementError('DNSFILTER_UNAVAILABLE'); } finally { clearTimeout(timer); }
    if (!response.ok) throw new DnsFilterManagementError(init.method === 'POST' ? 'DNSFILTER_CREATE_OUTCOME_UNKNOWN' : 'DNSFILTER_UNAVAILABLE');
    try { return object(await response.json()); } catch { throw new DnsFilterManagementError('DNSFILTER_SHAPE_UNKNOWN'); }
  }
  private async pages(initialPath: string, expectedPath: string): Promise<unknown[]> {
    let next: string | null = initialPath;
    const seen = new Set<string>(); const rows: unknown[] = [];
    while (next !== null) {
      let url: URL; try { url = new URL(next, 'https://api.dnsfilter.com'); } catch { throw new DnsFilterManagementError('DNSFILTER_SHAPE_UNKNOWN'); }
      if (url.protocol !== 'https:' || url.hostname !== 'api.dnsfilter.com' || url.port || url.username || url.password || url.hash || url.pathname !== expectedPath || seen.has(url.href) || seen.size >= 10_000) throw new DnsFilterManagementError('DNSFILTER_SHAPE_UNKNOWN');
      seen.add(url.href);
      const body = await this.request(`${url.pathname}${url.search}`, { method: 'GET' });
      if (!Array.isArray(body.data)) throw new DnsFilterManagementError('DNSFILTER_SHAPE_UNKNOWN');
      rows.push(...body.data);
      const links = object(body.links); const candidate = links.next;
      if (candidate !== null && typeof candidate !== 'string') throw new DnsFilterManagementError('DNSFILTER_SHAPE_UNKNOWN');
      if (candidate === '') throw new DnsFilterManagementError('DNSFILTER_SHAPE_UNKNOWN');
      next = candidate;
    }
    return rows;
  }
  async listOrganizations(): Promise<Array<{ id: string; name: string }>> {
    const rows = await this.pages('/v1/organizations', '/v1/organizations');
    const ids = new Set<string>(); const organizations: Array<{ id: string; name: string }> = [];
    for (const value of rows) {
      const r = object(value); const a = object(r.attributes); const organizationId = id(r.id);
      if (ids.has(organizationId)) throw new DnsFilterManagementError('DNSFILTER_SHAPE_UNKNOWN');
      ids.add(organizationId);
      const parent = a.managed_by_msp_id;
      // The MSP list includes its own Organization without a managed_by_msp_id. It is not a customer tenant.
      if (parent === null || parent === undefined) continue;
      if (id(parent) !== this.mspId || typeof a.name !== 'string') throw new DnsFilterManagementError('DNSFILTER_SHAPE_UNKNOWN');
      organizations.push({ id: organizationId, name: a.name });
    }
    return organizations;
  }
  async getOrganization(organizationId: string): Promise<{ id: string; name: string }> {
    const body = await this.request(`/v1/organizations/${encodeURIComponent(organizationId)}`, { method: 'GET' }); const data = object(body.data); const attributes = object(data.attributes); if (id(data.id) !== organizationId || id(attributes.managed_by_msp_id) !== this.mspId || typeof attributes.name !== 'string') throw new DnsFilterManagementError('DNSFILTER_SHAPE_UNKNOWN'); return { id: organizationId, name: attributes.name };
  }
  async createOrganization(name: string): Promise<{ id: string; name: string }> {
    const body = await this.request('/v1/organizations', { method: 'POST', body: JSON.stringify({ organization: { name, managed_by_msp_id: Number(this.mspId) } }) }); const data = object(body.data); const attributes = object(data.attributes); const created = id(data.id); if (id(attributes.managed_by_msp_id) !== this.mspId || typeof attributes.name !== 'string') throw new DnsFilterManagementError('DNSFILTER_CREATE_OUTCOME_UNKNOWN'); return { id: created, name: attributes.name };
  }
  async listPolicies(organizationId: string): Promise<Array<{ id: string; name: string; global: boolean }>> {
    const body = await this.request(`/v1/policies?organization_id=${encodeURIComponent(organizationId)}&include_global_policies=true`, { method: 'GET' }); const data = body.data; if (!Array.isArray(data)) throw new DnsFilterManagementError('DNSFILTER_SHAPE_UNKNOWN'); return data.map((v) => { const r = object(v); const a = object(r.attributes); if (typeof a.name !== 'string') throw new DnsFilterManagementError('DNSFILTER_SHAPE_UNKNOWN'); return { id: id(r.id), name: a.name, global: a.is_global_policy === true }; });
  }
  async listNetworks(organizationId: string): Promise<Array<{ id: string; name: string }>> {
    const body = await this.request(`/v1/networks?organization_id=${encodeURIComponent(organizationId)}`, { method: 'GET' }); if (!Array.isArray(body.data)) throw new DnsFilterManagementError('DNSFILTER_SHAPE_UNKNOWN');
    return body.data.map((v) => { const r = object(v); const a = object(r.attributes); const relation = object(object(r.relationships).organization); const owner = id(object(relation.data).id); if (owner !== organizationId || typeof a.name !== 'string') throw new DnsFilterManagementError('DNSFILTER_SHAPE_UNKNOWN'); return { id: id(r.id), name: a.name }; });
  }
  async createNetwork(organizationId: string, name: string, policyIds: string[]): Promise<{ id: string; name: string }> {
    const body = await this.request('/v1/networks', { method: 'POST', body: JSON.stringify({ network: { name, organization_id: Number(organizationId), policy_ids: policyIds.map(Number) } }) }); const data = object(body.data); const a = object(data.attributes); if (typeof a.name !== 'string') throw new DnsFilterManagementError('DNSFILTER_CREATE_OUTCOME_UNKNOWN'); return { id: id(data.id), name: a.name };
  }
}
