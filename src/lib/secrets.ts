import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

const client = new SecretManagerServiceClient();

/**
 * Secret Managerから最新バージョンの値を取得する。
 *
 * Cloud Run本番環境では `--set-secrets` で環境変数に直接マウントされるため、
 * 通常はこの関数を呼ばずに process.env から読める。ローカル開発やワークステーション
 * から実行するスクリプト（migrations/runner.ts, scripts/onboarding/*）など、
 * Cloud Runの外で動く場合のフォールバック用。
 */
export async function getSecret(projectId: string, secretId: string): Promise<string> {
  const [version] = await client.accessSecretVersion({
    name: `projects/${projectId}/secrets/${secretId}/versions/latest`,
  });
  const data = version.payload?.data;
  if (!data) {
    throw new Error(`Secret ${secretId} has no payload`);
  }
  return typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
}
