export type SettingKey =
  | 'booking_url'
  | 'customer_application_notify_email'
  | 'slack_webhook_customer_application';

export interface SettingMeta {
  key: SettingKey;
  label: string;
  helpText: string;
  /** 空文字を許容するか（=「未設定に戻す」操作を許すか）。任意項目のみtrue。 */
  allowEmpty: boolean;
}

export const SETTINGS_META: SettingMeta[] = [
  {
    key: 'booking_url',
    label: '日程調整予約リンク（TimeRex等）',
    helpText: '顧客申込みフォームの確認メール・完了画面で案内するURL',
    allowEmpty: false,
  },
  {
    key: 'customer_application_notify_email',
    label: '顧客申込み通知先メールアドレス',
    helpText: 'カンマ区切りで複数指定可',
    allowEmpty: false,
  },
  {
    key: 'slack_webhook_customer_application',
    label: '顧客申込み Slack Webhook URL',
    helpText: '空欄にするとSlack通知をスキップします（任意項目）',
    allowEmpty: true,
  },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidUrl(value: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** バリデーションエラーがあればメッセージを、無ければnullを返す。 */
export function validateSettingValue(key: SettingKey, value: string): string | null {
  const meta = SETTINGS_META.find((m) => m.key === key);
  if (meta?.allowEmpty && value === '') return null;

  switch (key) {
    case 'booking_url':
      return isValidUrl(value) ? null : '有効なURLを入力してください';
    case 'customer_application_notify_email': {
      const emails = value
        .split(',')
        .map((e) => e.trim())
        .filter((e) => e.length > 0);
      if (emails.length === 0) return '1件以上のメールアドレスを指定してください';
      if (emails.some((e) => !EMAIL_RE.test(e))) return '有効なメールアドレスをカンマ区切りで入力してください';
      return null;
    }
    case 'slack_webhook_customer_application':
      return isValidUrl(value) ? null : '有効なURLを入力してください（空欄で通知をスキップ）';
  }
}
