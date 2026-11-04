import { getSecret } from '../lib/secrets';

export interface DnsFilterRoamingUsage {
  roamingClientsInUse: number;
  dnsfilterAllocatedRoamingClients: number;
  retrievedAt: string;
  from: string;
  to: string;
}

/** A single official, Organization-scoped GET. Never infer usage from Agent records. */
export class DnsFilterRoamingUsageError extends Error {
  constructor() { super('DNSFILTER_ROAMING_USAGE_UNAVAILABLE'); }
}

function fail(): never { throw new DnsFilterRoamingUsageError(); }
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail();
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

/**
 * Does not configure alerts, update billing, access other Organizations,
 * or call any DNSFilter mutation API.
 */
export class DnsFilterRoamingUsageClient {
  constructor(
    private readonly projectId: string,
    private readonly key: () => string | Promise<string> =
      () => process.env.DNSFILTER_API_KEY ?? getSecret(projectId, 'secure-guard-dnsfilter-api-key'),
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly timeoutMs = 8_000,
  ) {}

  async getRoamingUsage(organizationId: string): Promise<DnsFilterRoamingUsage> {
    if (!/^\d+$/.test(organizationId) || !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) fail();
    let key: string;
    try { key = await this.key(); } catch { fail(); }
    if (typeof key !== 'string' || !key.trim()) fail();

    const current = this.now();
    if (!(current instanceof Date) || !Number.isFinite(current.getTime())) fail();
    const to = current.toISOString().slice(0, 10);
    const from = new Date(current.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
    const url = new URL(`/v1/metrics/organization_usage_detailed/${organizationId}`, 'https://api.dnsfilter.com');
    url.searchParams.set('from', from);
    url.searchParams.set('to', to);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(url.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch {
      fail();
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok || response.status !== 200) fail();

    let data: Record<string, unknown>;
    try { data = object(object(await response.json()).data); } catch { fail(); }
    const responseOrg = data.organization_id;
    if (typeof responseOrg !== 'string' && typeof responseOrg !== 'number') fail();
    if (String(responseOrg) !== organizationId) fail();
    return {
      roamingClientsInUse: count(data.roaming_clients_in_use),
      dnsfilterAllocatedRoamingClients: count(data.allocated_roaming_clients),
      retrievedAt: current.toISOString(),
      from,
      to,
    };
  }
}
