import type { Pool } from 'pg';
import { lookupGroup } from './groupMembershipService';
import type { AdminPrincipal, PrincipalType } from '../domain/staffRoles';

interface Row {
  id: string;
  principal_type: PrincipalType;
  value: string;
  group_resource_name: string | null;
  added_at: string;
}

export type RemoveResult = 'removed' | 'not_found' | 'last_principal';

/** admin_principals への問い合わせを一手に引き受けるリポジトリ。domain/staffRoles.tsのStaffRoleDepsを実装する。 */
export class AdminPrincipalsRepo {
  constructor(private readonly pool: Pool) {}

  async listAdminPrincipals(): Promise<AdminPrincipal[]> {
    const { rows } = await this.pool.query<Row>(
      'SELECT id, principal_type, value, group_resource_name FROM admin_principals ORDER BY added_at',
    );
    return rows.map(mapRow);
  }

  async add(principalType: PrincipalType, rawValue: string): Promise<AdminPrincipal> {
    const value = rawValue.trim().toLowerCase();
    // typeが'group'の場合、追加時点で解決できないメールアドレス(実在しないグループ等)を即座にエラーにする
    // (ログイン時まで気づけないと運用者が原因調査しづらいため)。
    const groupResourceName = principalType === 'group' ? await lookupGroup(value) : null;

    const { rows } = await this.pool.query<Row>(
      `INSERT INTO admin_principals (principal_type, value, group_resource_name)
       VALUES ($1, $2, $3)
       RETURNING id, principal_type, value, group_resource_name`,
      [principalType, value, groupResourceName],
    );
    const row = rows[0];
    if (!row) throw new Error('AdminPrincipalsRepo.add: insert returned no row');
    return mapRow(row);
  }

  /** 最後の1件は削除できない(誰も管理者になれなくなるのを防ぐガード)。 */
  async remove(id: string): Promise<RemoveResult> {
    const { rows: countRows } = await this.pool.query<{ count: string }>('SELECT count(*) FROM admin_principals');
    if (Number(countRows[0]?.count ?? 0) <= 1) return 'last_principal';

    const { rowCount } = await this.pool.query('DELETE FROM admin_principals WHERE id = $1', [id]);
    return rowCount && rowCount > 0 ? 'removed' : 'not_found';
  }

  async resolveAndCacheGroupResourceName(principalId: string, groupEmail: string): Promise<string> {
    const resourceName = await lookupGroup(groupEmail);
    await this.pool.query('UPDATE admin_principals SET group_resource_name = $1 WHERE id = $2', [
      resourceName,
      principalId,
    ]);
    return resourceName;
  }
}

function mapRow(row: Row): AdminPrincipal {
  return {
    id: row.id,
    principalType: row.principal_type,
    value: row.value,
    groupResourceName: row.group_resource_name,
  };
}
