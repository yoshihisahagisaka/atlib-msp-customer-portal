import type { Pool } from 'pg';

export type ApplicationReviewStatus = 'new' | 'contacted' | 'scheduled' | 'closed';

export interface CustomerApplicationInput {
  companyName: string;
  contactName: string;
  email: string;
  phone?: string;
  interestedPlan?: string;
  message?: string;
  sourceIp?: string;
}

export interface CustomerApplicationListItem {
  id: string;
  companyName: string;
  contactName: string;
  email: string;
  phone: string | null;
  interestedPlan: string | null;
  reviewStatus: ApplicationReviewStatus;
  notificationEmailSentAt: string | null;
  submittedAt: string;
}

export interface CustomerApplicationDetail extends CustomerApplicationListItem {
  message: string | null;
}

interface Row {
  id: string;
  company_name: string;
  contact_name: string;
  email: string;
  phone: string | null;
  interested_plan: string | null;
  message: string | null;
  review_status: ApplicationReviewStatus;
  notification_email_sent_at: string | null;
  submitted_at: string;
}

/** customer_applications への問い合わせを一手に引き受けるリポジトリ。opsHistoryRepo.tsと同じ構造。 */
export class CustomerApplicationRepo {
  constructor(private readonly pool: Pool) {}

  async insertApplication(input: CustomerApplicationInput): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO customer_applications
         (company_name, contact_name, email, phone, interested_plan, message, source_ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        input.companyName,
        input.contactName,
        input.email,
        input.phone ?? null,
        input.interestedPlan ?? null,
        input.message ?? null,
        input.sourceIp ?? null,
      ],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('insertApplication: insert returned no id');
    return id;
  }

  async markNotificationSent(id: string): Promise<void> {
    await this.pool.query('UPDATE customer_applications SET notification_email_sent_at = now() WHERE id = $1', [id]);
  }

  async listApplications(opts: {
    status?: ApplicationReviewStatus;
    limit: number;
    offset: number;
  }): Promise<{ items: CustomerApplicationListItem[]; total: number }> {
    const params: unknown[] = [];
    let where = '';
    if (opts.status) {
      params.push(opts.status);
      where = `WHERE review_status = $${params.length}`;
    }

    const { rows: countRows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM customer_applications ${where}`,
      params,
    );
    const total = Number(countRows[0]?.count ?? 0);

    params.push(opts.limit, opts.offset);
    const { rows } = await this.pool.query<Row>(
      `SELECT id, company_name, contact_name, email, phone, interested_plan,
              review_status, notification_email_sent_at, submitted_at
       FROM customer_applications
       ${where}
       ORDER BY submitted_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return { items: rows.map(mapListRow), total };
  }

  async findById(id: string): Promise<CustomerApplicationDetail | null> {
    const { rows } = await this.pool.query<Row>(
      `SELECT id, company_name, contact_name, email, phone, interested_plan, message,
              review_status, notification_email_sent_at, submitted_at
       FROM customer_applications WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) return null;
    return { ...mapListRow(row), message: row.message };
  }

  /** 対応状況の更新。存在しないidの場合はfalseを返す（呼び出し側で404にする）。 */
  async updateReviewStatus(id: string, status: ApplicationReviewStatus): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'UPDATE customer_applications SET review_status = $1, updated_at = now() WHERE id = $2',
      [status, id],
    );
    return (rowCount ?? 0) > 0;
  }
}

function mapListRow(row: Row): CustomerApplicationListItem {
  return {
    id: row.id,
    companyName: row.company_name,
    contactName: row.contact_name,
    email: row.email,
    phone: row.phone,
    interestedPlan: row.interested_plan,
    reviewStatus: row.review_status,
    notificationEmailSentAt: row.notification_email_sent_at,
    submittedAt: row.submitted_at,
  };
}
