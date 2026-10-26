import nodemailer, { type Transporter } from 'nodemailer';
import type { Config } from '../config';

export interface CustomerApplicationSummary {
  id: string;
  companyName: string;
  contactName: string;
  email: string;
  phone?: string;
  interestedPlan?: string;
  message?: string;
  submittedAt: Date;
  detailUrl: string;
}

export class Mailer {
  private readonly transporter: Transporter;

  constructor(private readonly config: Config['smtp']) {
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: false, // 587 + STARTTLS（Google Workspace SMTPリレーの標準構成）
      auth: {
        user: config.user,
        pass: config.password,
      },
    });
  }

  async sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
    await this.transporter.sendMail({
      from: this.config.from,
      to,
      subject: 'atLIB InfraVision - パスワード再設定のご案内',
      text: [
        'パスワード再設定のリクエストを受け付けました。',
        '以下のURLから1時間以内に新しいパスワードを設定してください。',
        '',
        resetUrl,
        '',
        'このメールに心当たりがない場合は、破棄してください。',
      ].join('\n'),
    });
  }

  async sendWelcomeEmail(to: string, companyName: string, temporaryPassword: string, loginUrl: string): Promise<void> {
    await this.transporter.sendMail({
      from: this.config.from,
      to,
      subject: 'atLIB InfraVision セルフサービスポータル ご利用開始のご案内',
      text: [
        `${companyName} 様`,
        '',
        'atLIB InfraVision セルフサービスポータルのご利用を開始いただけます。',
        `ログインURL: ${loginUrl}`,
        `初期パスワード: ${temporaryPassword}`,
        '',
        '初回ログイン後、お早めにパスワードの変更をお願いいたします。',
      ].join('\n'),
    });
  }

  async sendSecureGuardInvitationEmail(to: string, acceptUrl: string): Promise<void> {
    await this.transporter.sendMail({
      from: this.config.from,
      to,
      subject: 'atLIB Secure Guard ご利用開始のご案内',
      text: [
        'atLIB Secure Guardへの招待を受け付けました。',
        '以下のURLを開き、個人用パスワードを設定してください。',
        '',
        acceptUrl,
        '',
        'この招待は24時間で失効し、一度だけ利用できます。心当たりがない場合は破棄してください。',
      ].join('\n'),
    });
  }

  /**
   * toはカンマ区切りで複数宛先可。生成済みPPTXをそのまま添付して送る。
   * fromは通常のSMTP_FROM(個人メールボックス)とは別に、月次レポート専用の送信元(noreply@atlib.jp等)を渡す想定。
   */
  async sendMonthlyReportEmail(
    to: string,
    from: string,
    info: { companyName: string; reportPeriod: string },
    attachment: Buffer,
  ): Promise<void> {
    await this.transporter.sendMail({
      from,
      to,
      subject: `【atLIB】月次インフラ健全性報告書(${info.reportPeriod}) - ${info.companyName} 様`,
      text: [
        `${info.companyName} 様`,
        '',
        `${info.reportPeriod}分の月次インフラ健全性報告書をお送りいたします。`,
        '添付のファイルをご確認ください。',
        '',
        'ご不明な点がございましたら、お気軽にお問い合わせください。',
      ].join('\n'),
      attachments: [
        {
          filename: `atLIB_Monthly_Report_${info.companyName}_${info.reportPeriod}.pptx`,
          content: attachment,
        },
      ],
    });
  }

  /** toはカンマ区切りで複数宛先可。バッチ完了後、運用担当への承認待ち通知。fromはsendMonthlyReportEmailと同じ専用送信元。 */
  async sendMonthlyReportBatchSummary(
    to: string,
    from: string,
    draftCount: number,
    failedCount: number,
    adminUrl: string,
  ): Promise<void> {
    await this.transporter.sendMail({
      from,
      to,
      subject: `【atLIB】月次レポート自動生成完了(承認待ち${draftCount}件)`,
      text: [
        '月次レポートの自動生成バッチが完了しました。',
        '',
        `承認待ち: ${draftCount}件`,
        `生成失敗: ${failedCount}件`,
        '',
        `管理画面: ${adminUrl}`,
        '',
        '上記から内容を確認し、承認・送信してください。',
      ].join('\n'),
    });
  }

  /** toはカンマ区切りで複数宛先可（nodemailerがそのまま複数宛先として解釈する）。 */
  async sendCustomerApplicationNotification(to: string, summary: CustomerApplicationSummary): Promise<void> {
    await this.transporter.sendMail({
      from: this.config.from,
      to,
      subject: `【新規申込み】${summary.companyName} 様`,
      text: [
        `${summary.companyName} 様より、サービス申込みフォームへの送信がありました。`,
        '',
        `会社名: ${summary.companyName}`,
        `担当者: ${summary.contactName}`,
        `メール: ${summary.email}`,
        summary.phone ? `電話番号: ${summary.phone}` : null,
        summary.interestedPlan ? `興味のあるプラン: ${summary.interestedPlan}` : null,
        summary.message ? `ご要望・備考: ${summary.message}` : null,
        `送信日時: ${summary.submittedAt.toLocaleString('ja-JP')}`,
        '',
        `詳細を管理画面で確認: ${summary.detailUrl}`,
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
    });
  }

  /** 申込み送信直後、顧客本人へ即時送信する自動返信。担当者からの連絡を待たずに日程調整できるよう予約リンクを案内する。 */
  async sendCustomerApplicationConfirmation(to: string, companyName: string, bookingUrl: string): Promise<void> {
    await this.transporter.sendMail({
      from: this.config.from,
      to,
      subject: 'atLIB InfraVision お申込みありがとうございます',
      text: [
        `${companyName} 様`,
        '',
        'この度はatLIB InfraVisionへお申込みいただき、誠にありがとうございます。',
        '担当者よりご連絡する前に、以下のリンクからヒアリングのご都合の良い日時をご予約いただけます。',
        '',
        bookingUrl,
        '',
        '内容を確認のうえ、担当者より改めてご連絡いたします。',
      ].join('\n'),
    });
  }
}
