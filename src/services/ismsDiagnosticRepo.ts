import type { Pool } from 'pg';
import type { AnswerSnapshot, CategoryRecommendation } from '../domain/ismsDiagnostic';

export type ReviewStatus = 'new' | 'contacted' | 'closed';

export interface DiagnosticSubmissionInput {
  companyName: string;
  contactName: string;
  email: string;
  phone?: string;
  questionSetVersion: string;
  answers: AnswerSnapshot[];
  categoryScores: Record<string, number>;
  recommendations: Record<string, CategoryRecommendation>;
  sourceIp?: string;
}

export interface DiagnosticSubmissionListItem {
  id: string;
  companyName: string;
  contactName: string;
  email: string;
  categoryScores: Record<string, number>;
  recommendations: Record<string, CategoryRecommendation>;
  reviewStatus: ReviewStatus;
  notificationEmailSentAt: string | null;
  submittedAt: string;
}

export interface DiagnosticSubmissionDetail extends DiagnosticSubmissionListItem {
  phone: string | null;
  questionSetVersion: string;
  answers: AnswerSnapshot[];
}

interface ListRow {
  id: string;
  company_name: string;
  contact_name: string;
  email: string;
  category_scores: Record<string, number>;
  recommendations: Record<string, CategoryRecommendation>;
  review_status: ReviewStatus;
  notification_email_sent_at: string | null;
  submitted_at: string;
}

interface DetailRow extends ListRow {
  phone: string | null;
  question_set_version: string;
  answers: AnswerSnapshot[];
}

/**
 * isms_diagnostic_submissions への問い合わせを一手に引き受けるリポジトリ。
 * category_scores/recommendations/answersはJSONB列で、node-postgresが自動でJSオブジェクトに
 * デシリアライズして返す（読み取り側でJSON.parseは不要）。書き込み側はJSON.stringifyが必要。
 */
export class IsmsDiagnosticRepo {
  constructor(private readonly pool: Pool) {}

  async insertSubmission(input: DiagnosticSubmissionInput): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO isms_diagnostic_submissions
         (company_name, contact_name, email, phone, question_set_version, answers, category_scores, recommendations, source_ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        input.companyName,
        input.contactName,
        input.email,
        input.phone ?? null,
        input.questionSetVersion,
        JSON.stringify(input.answers),
        JSON.stringify(input.categoryScores),
        JSON.stringify(input.recommendations),
        input.sourceIp ?? null,
      ],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('insertSubmission: insert returned no id');
    return id;
  }

  async markNotificationSent(id: string): Promise<void> {
    await this.pool.query('UPDATE isms_diagnostic_submissions SET notification_email_sent_at = now() WHERE id = $1', [
      id,
    ]);
  }

  async listSubmissions(opts: {
    status?: ReviewStatus;
    limit: number;
    offset: number;
  }): Promise<{ items: DiagnosticSubmissionListItem[]; total: number }> {
    const params: unknown[] = [];
    let where = '';
    if (opts.status) {
      params.push(opts.status);
      where = `WHERE review_status = $${params.length}`;
    }

    const { rows: countRows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM isms_diagnostic_submissions ${where}`,
      params,
    );
    const total = Number(countRows[0]?.count ?? 0);

    params.push(opts.limit, opts.offset);
    const { rows } = await this.pool.query<ListRow>(
      `SELECT id, company_name, contact_name, email, category_scores, recommendations,
              review_status, notification_email_sent_at, submitted_at
       FROM isms_diagnostic_submissions
       ${where}
       ORDER BY submitted_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return { items: rows.map(mapListRow), total };
  }

  async findById(id: string): Promise<DiagnosticSubmissionDetail | null> {
    const { rows } = await this.pool.query<DetailRow>(
      `SELECT id, company_name, contact_name, email, phone, question_set_version, answers,
              category_scores, recommendations, review_status, notification_email_sent_at, submitted_at
       FROM isms_diagnostic_submissions WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      ...mapListRow(row),
      phone: row.phone,
      questionSetVersion: row.question_set_version,
      answers: row.answers,
    };
  }

  /** 対応状況の更新。存在しないidの場合はfalseを返す（呼び出し側で404にする）。 */
  async updateReviewStatus(id: string, status: ReviewStatus): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'UPDATE isms_diagnostic_submissions SET review_status = $1, updated_at = now() WHERE id = $2',
      [status, id],
    );
    return (rowCount ?? 0) > 0;
  }
}

function mapListRow(row: ListRow): DiagnosticSubmissionListItem {
  return {
    id: row.id,
    companyName: row.company_name,
    contactName: row.contact_name,
    email: row.email,
    categoryScores: row.category_scores,
    recommendations: row.recommendations,
    reviewStatus: row.review_status,
    notificationEmailSentAt: row.notification_email_sent_at,
    submittedAt: row.submitted_at,
  };
}
