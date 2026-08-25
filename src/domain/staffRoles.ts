export type StaffRole = 'admin' | 'general';
export type PrincipalType = 'email' | 'group';

export interface AdminPrincipal {
  id: string;
  principalType: PrincipalType;
  value: string; // メールアドレス(個人 or グループ)。小文字化済み
  groupResourceName: string | null; // type='group'のみ。未解決ならnull
}

export interface StaffRoleDeps {
  listAdminPrincipals(): Promise<AdminPrincipal[]>;
  /** group_resource_nameが未解決(null)の場合に解決してDBへキャッシュする。失敗時は例外を投げる。 */
  resolveAndCacheGroupResourceName(principalId: string, groupEmail: string): Promise<string>;
  isGroupMember(groupResourceName: string, email: string): Promise<boolean>;
}

/**
 * atlib.jpドメイン内かどうかの判定(hdクレーム検査)はroutes/staffAuth.ts側の責務。
 * ここでは「ドメイン内であることは確認済みのメールアドレス」を前提に、管理者ロールかどうかだけを判定する
 * （management_principalsに一致しなければ既定で'general'。ログイン自体を拒否することはない）。
 */
export async function resolveStaffRole(email: string, deps: StaffRoleDeps): Promise<StaffRole> {
  const normalizedEmail = email.toLowerCase();
  const principals = await deps.listAdminPrincipals();

  for (const principal of principals) {
    if (principal.principalType === 'email') {
      if (principal.value === normalizedEmail) return 'admin';
      continue;
    }

    let resourceName = principal.groupResourceName;
    if (!resourceName) {
      try {
        resourceName = await deps.resolveAndCacheGroupResourceName(principal.id, principal.value);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`staffRoles: グループ"${principal.value}"のリソース名解決に失敗しました:`, err);
        continue;
      }
    }

    try {
      if (await deps.isGroupMember(resourceName, normalizedEmail)) return 'admin';
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`staffRoles: グループ"${principal.value}"のメンバーシップ確認に失敗しました:`, err);
    }
  }

  return 'general';
}
