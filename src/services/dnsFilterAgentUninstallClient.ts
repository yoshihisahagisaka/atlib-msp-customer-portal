const API_ROOT = 'https://api.dnsfilter.com';

/** Only the PoC-verified queued uninstall is permitted. Never fall back to a soft delete. */
export class DnsFilterAgentUninstallClient {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 8_000,
  ) {}

  isConfigured(): boolean { return Boolean(this.apiKey); }

  /** One HTTP request, no automatic retry under any response/timeout condition. */
  async requestQueuedUninstall(agentUuid: string): Promise<void> {
    if (!this.apiKey || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(agentUuid)
      || !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('DNSFILTER_AGENT_UNINSTALL_UNAVAILABLE');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(`${API_ROOT}/v1/user_agents/${encodeURIComponent(agentUuid)}?queue_uninstall=true`, {
        method: 'DELETE',
        redirect: 'manual',
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
        signal: controller.signal,
      });
      // 204 means DNSFilter accepted the queue request, not that the device finished uninstalling.
      if (response.status !== 204) throw new Error('DNSFILTER_AGENT_UNINSTALL_OUTCOME_UNKNOWN');
    } catch {
      // No response body or credentials are exposed to callers or logs.
      throw new Error('DNSFILTER_AGENT_UNINSTALL_OUTCOME_UNKNOWN');
    } finally {
      clearTimeout(timer);
    }
  }
}
