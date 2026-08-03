/**
 * Slack Incoming Webhookへの通知。webhookUrlが未設定(undefined)なら何もしない。
 * 例外・非2xxレスポンスは内部でログするだけで呼び出し元へは投げない
 * (メール通知と同じ「失敗しても他へ影響しないbest-effort」性質をこの関数自身が保証する)。
 */
export async function sendSlackNotification(webhookUrl: string | undefined, text: string): Promise<void> {
  if (!webhookUrl) return;

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.error(`Slack notification failed: HTTP ${res.status}`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Slack notification failed:', err);
  }
}
