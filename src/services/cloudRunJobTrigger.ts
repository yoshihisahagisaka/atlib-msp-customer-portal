import { GoogleAuth } from 'google-auth-library';

/**
 * Cloud Run Job「msp-discovery-setup」（zabbixserver/batch/setup_discovery.pyをコンテナ化したもの）を
 * Cloud Run Admin APIで起動する。setup_discovery.py自体のロジック・過去の実障害対応で積み上がった
 * 安全チェックは一切変更せず、実行のトリガーだけをSSHからAPI呼び出しに置き換える。
 *
 * @google-cloud/run 等の専用SDKは追加せず、既存依存のgoogle-auth-libraryで取得したOAuth2アクセス
 * トークンを使い生のfetchで呼ぶ（このコードベースの「自前最小実装」方針に合わせる。
 * batch/generate-monthly-reports.tsのgetIapIdToken()と同じライブラリだが、そちらはIAP向けの
 * IDトークン、こちらは通常のGoogle Cloud REST API向けのOAuth2アクセストークンが必要なため
 * GoogleAuth#getClient()を使う点が異なる）。
 */

export interface CloudRunJobConfig {
  projectId: string;
  region: string;
  discoverySetupJobName?: string; // 未設定ならJob起動をスキップ（段階的ロールアウト用）
}

export interface DiscoverySetupJobInput {
  customerCode: string;
  companyName: string;
  ipRange: string;
  proxyId?: string;
}

export async function triggerDiscoverySetupJob(
  config: CloudRunJobConfig,
  input: DiscoverySetupJobInput,
): Promise<void> {
  if (!config.discoverySetupJobName) {
    throw new Error('DISCOVERY_SETUP_JOB_NAME未設定のためJob起動をスキップしました');
  }

  const args = [
    '--apply',
    '--customer-code', input.customerCode,
    '--company-name', input.companyName,
    '--ip-range', input.ipRange,
  ];
  if (input.proxyId) {
    args.push('--proxy-id', input.proxyId);
  }

  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const headers = await client.getRequestHeaders();

  const url = `https://run.googleapis.com/v2/projects/${config.projectId}/locations/${config.region}/jobs/${config.discoverySetupJobName}:run`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ overrides: { containerOverrides: [{ args }] } }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Cloud Run Job (${config.discoverySetupJobName}) 起動に失敗しました: HTTP ${res.status} ${body}`);
  }
}
