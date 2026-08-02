-- 顧客申込みフォーム（公開・認証不要）の送信内容を保存するテーブル
-- 002_isms_diagnostic.sqlの作法を踏襲（UUID PK + pgcrypto、TIMESTAMPTZ、enumの代わりにCHECK）
--
-- ここに集めるのはヒアリング前の一次受付情報のみ。IPレンジ等の技術的ヒアリング項目・
-- customer_codeの割当は、この後の人間によるヒアリング（Web会議）で確定し、既存の
-- 手順0以降（顧客マスタへの割当・npm run onboard）で扱う（本テーブルはそこに接続しない）。

CREATE TABLE customer_applications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name      TEXT NOT NULL,
  contact_name      TEXT NOT NULL,
  email             TEXT NOT NULL,
  phone             TEXT,
  interested_plan   TEXT,
  message           TEXT,
  review_status     TEXT NOT NULL DEFAULT 'new' CHECK (review_status IN ('new', 'contacted', 'scheduled', 'closed')),
  notification_email_sent_at TIMESTAMPTZ,  -- NULLは通知未送信/失敗。admin一覧でのフラグ表示に使う
  source_ip         TEXT,
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_customer_applications_submitted_at ON customer_applications(submitted_at DESC);
CREATE INDEX idx_customer_applications_review_status ON customer_applications(review_status);
