export interface SecureGuardLicenseAlert {
  organizationName: string;
  usage: number;
  allocation: number;
  overage: number;
  checkedAt: string;
  portalUrl?: string;
}

export type SlackDeliveryResult = 'sent' | 'unconfigured' | 'failed';

/** Dedicated Secure Guard adapter. It never logs or returns the webhook URL. */
export class SecureGuardLicenseSlack {
  constructor(
    private readonly webhookUrl: string | undefined,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  isConfigured(): boolean { return Boolean(this.webhookUrl); }

  async send(alert: SecureGuardLicenseAlert): Promise<SlackDeliveryResult> {
    if (!this.webhookUrl) return 'unconfigured';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const lines = [
        'Secure Guard ライセンス超過',
        `顧客: ${alert.organizationName}`,
        `DNSFilter API利用数: ${alert.usage}`,
        `転記割当数: ${alert.allocation}`,
        `超過数: ${alert.overage}`,
        `確認日時: ${alert.checkedAt}`,
      ];
      if (alert.portalUrl) lines.push(`管理画面: ${alert.portalUrl}`);
      const response = await this.fetcher(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: lines.join('\n') }),
        signal: controller.signal,
      });
      return response.ok ? 'sent' : 'failed';
    } catch {
      return 'failed';
    } finally {
      clearTimeout(timer);
    }
  }
}
