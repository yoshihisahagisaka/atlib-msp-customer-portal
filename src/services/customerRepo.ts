import type { Pool } from 'pg';

export interface Customer {
  id: string;
  customerCode: string;
  companyName: string;
  email: string;
  passwordHash: string;
  zabbixUserId: string;
  status: 'active' | 'suspended';
}

/**
 * customers / customer_hostgroups への問い合わせを一手に引き受けるリポジトリ。
 * JWTから解決した customerId を Zabbix側の識別子（groupids・userid）へ変換する、
 * このアプリで唯一許可された場所。ルート層はここを経由せずにZabbix識別子を
 * 得てはならない。
 */
export class CustomerRepo {
  constructor(private readonly pool: Pool) {}

  async findByEmail(email: string): Promise<Customer | null> {
    const { rows } = await this.pool.query(
      `SELECT id, customer_code, company_name, email, password_hash, zabbix_userid, status
       FROM customers WHERE email = $1 AND status = 'active'`,
      [email],
    );
    return rows[0] ? this.mapRow(rows[0]) : null;
  }

  async findById(customerId: string): Promise<Customer | null> {
    const { rows } = await this.pool.query(
      `SELECT id, customer_code, company_name, email, password_hash, zabbix_userid, status
       FROM customers WHERE id = $1 AND status = 'active'`,
      [customerId],
    );
    return rows[0] ? this.mapRow(rows[0]) : null;
  }

  /** 顧客に紐づく全ホストグループIDを返す。1件のみの顧客も配列長1で返す（分岐不要にするため）。 */
  async resolveHostgroupIds(customerId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ zabbix_groupid: string }>(
      'SELECT zabbix_groupid FROM customer_hostgroups WHERE customer_id = $1',
      [customerId],
    );
    return rows.map((r) => r.zabbix_groupid);
  }

  async getZabbixUserId(customerId: string): Promise<string> {
    const customer = await this.findById(customerId);
    if (!customer) throw new Error(`Customer not found: ${customerId}`);
    return customer.zabbixUserId;
  }

  async updatePasswordHash(customerId: string, passwordHash: string): Promise<void> {
    await this.pool.query(
      'UPDATE customers SET password_hash = $1, updated_at = now() WHERE id = $2',
      [passwordHash, customerId],
    );
  }

  async insertCustomer(input: {
    customerCode: string;
    companyName: string;
    email: string;
    passwordHash: string;
    zabbixUserId: string;
    zabbixActionId?: string;
  }): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO customers (customer_code, company_name, email, password_hash, zabbix_userid, zabbix_actionid)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        input.customerCode,
        input.companyName,
        input.email,
        input.passwordHash,
        input.zabbixUserId,
        input.zabbixActionId ?? null,
      ],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('insertCustomer: insert returned no id');
    return id;
  }

  async insertHostgroup(customerId: string, zabbixGroupId: string, groupName: string): Promise<void> {
    await this.pool.query(
      'INSERT INTO customer_hostgroups (customer_id, zabbix_groupid, group_name) VALUES ($1, $2, $3)',
      [customerId, zabbixGroupId, groupName],
    );
  }

  private mapRow(row: {
    id: string;
    customer_code: string;
    company_name: string;
    email: string;
    password_hash: string;
    zabbix_userid: string;
    status: 'active' | 'suspended';
  }): Customer {
    return {
      id: row.id,
      customerCode: row.customer_code,
      companyName: row.company_name,
      email: row.email,
      passwordHash: row.password_hash,
      zabbixUserId: row.zabbix_userid,
      status: row.status,
    };
  }
}
