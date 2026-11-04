/**
 * Secure Guard-only Slack adapter. It does NOT pick an arbitrary existing channel,
 * and is not wired to a scheduler until the official usage metric is confirmed.
 */
export interface SecureGuardOverageMessage {
  organizationName: string;
  usage: number;
  allocated: number;
  checkedAt: string;
  managementUrl?: string;
}
export type SecureGuardSlackDelivery = 'not_configured' | 'sent' | 'failed';

function safeName(value: string): string {
  // Prevent organization names from injecting newlines or Slack mass-mentions.
  return value.replace(/[\r\n\t]/g, ' ').replace(/@/g, '＠').replace(/[<>]/g, '');
}

export async function sendSecureGuardOverageSlack(
  webhookUrl: string | undefined,
  message: SecureGuardOverageMessage,
  fetcher: typeof fetch = fetch,
): Promise<SecureGuardSlackDelivery> {
  if (!webhookUrl) return 'not_configured';
  if (!Number.isSafeInteger(message.usage) || message.usage < 0 ||
      !Number.isSafeInteger(message.allocated) || message.allocated < 0 ||
      message.usage <= message.allocated ||
      !message.organizationName.trim() || Number.isNaN(Date.parse(message.checkedAt))) {
    return 'failed';
  }
  // A webhook URL is a secret; never include it in logs or error messages.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  const text = [
    '*【Secure Guard】割当ライセンス超過*',
    `顧客: ${safeName(message.organizationName)}`,
    `DNSFilter利用数: ${message.usage}台`,
    `割当ライセンス数（DNSFilter画面から転記）: ${message.allocated}台`,
    `超過: ${message.usage - message.allocated}台`,
    `確認日時: ${message.checkedAt}`,
    '不要端末の削除、または割当数の変更をご確認ください。',
    ...(message.managementUrl ? [`管理画面: ${message.managementUrl}`] : []),
  ].join('\n');
  try {
    const result = await fetcher(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    return result.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  } finally {
    clearTimeout(timer);
  }
}
