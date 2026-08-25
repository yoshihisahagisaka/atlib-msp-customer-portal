import { GoogleAuth } from 'google-auth-library';

/**
 * Cloud Identity Groups API（cloudidentity.googleapis.com）のラッパー。director@atlib.jpのような
 * Google Workspaceグループのメンバーシップを判定するために使う（GoogleのIDトークンにはグループの
 * メールアドレスは含まれず、ログインした個人のメールしか分からないため、管理者ロール判定に必要）。
 *
 * domain-wide delegationは使わない。cloudRunJobTrigger.tsと同じくGoogleAuth#getClient()経由の
 * 通常のサービスアカウント権限で呼ぶだけでよい（Google公式ドキュメント: 対象グループのオーナーに
 * サービスアカウントを追加すれば、group admin roleやDWDの割り当ては不要）。
 * 事前準備として msp-customer-portal-sa をチェック対象グループのオーナーに追加しておくこと。
 */

const SCOPES = ['https://www.googleapis.com/auth/cloud-identity.groups.readonly'];

async function authorizedFetch(url: string): Promise<Response> {
  const auth = new GoogleAuth({ scopes: SCOPES });
  const client = await auth.getClient();
  const headers = await client.getRequestHeaders();
  return fetch(url, { headers });
}

/** グループのメールアドレスからリソース名("groups/{id}")を解決する。設定画面でグループ登録時に1回だけ呼ぶ想定。 */
export async function lookupGroup(groupEmail: string): Promise<string> {
  const url = `https://cloudidentity.googleapis.com/v1/groups:lookup?groupKey.id=${encodeURIComponent(groupEmail)}`;
  const res = await authorizedFetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`グループ(${groupEmail})が見つかりませんでした: HTTP ${res.status} ${body}`);
  }
  const data = (await res.json()) as { name?: string };
  if (!data.name) {
    throw new Error(`グループ(${groupEmail})のリソース名を取得できませんでした`);
  }
  return data.name;
}

/** 指定メールアドレスがグループの（間接メンバーも含む）メンバーかどうかを判定する。ログイン都度呼ぶ想定。 */
export async function isGroupMember(groupResourceName: string, email: string): Promise<boolean> {
  const query = `member_key_id=='${email.replace(/'/g, "\\'")}'`;
  const url = `https://cloudidentity.googleapis.com/v1/${groupResourceName}/memberships:checkTransitiveMembership?query=${encodeURIComponent(query)}`;
  const res = await authorizedFetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`グループメンバーシップの確認に失敗しました: HTTP ${res.status} ${body}`);
  }
  const data = (await res.json()) as { hasMembership?: boolean };
  return data.hasMembership === true;
}
