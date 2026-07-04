import nodemailer, { type Transporter } from 'nodemailer';
import type { Config } from '../config';

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
}
