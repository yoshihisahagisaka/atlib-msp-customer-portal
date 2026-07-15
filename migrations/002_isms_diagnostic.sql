-- ISMS支援プラン診断フォームの回答保存用テーブル
-- 001_init.sqlの作法を踏襲（UUID PK + pgcrypto、TIMESTAMPTZ、enumの代わりにCHECK）

CREATE TABLE isms_diagnostic_submissions (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name                TEXT NOT NULL,
  contact_name                TEXT NOT NULL,
  email                       TEXT NOT NULL,
  phone                       TEXT,
  question_set_version        TEXT NOT NULL,
  answers                     JSONB NOT NULL,              -- 質問文・選択肢ラベルまでスナップショットしたQ&A配列
  category_scores             JSONB NOT NULL,              -- 例: {"X": 9, "Y": 6}
  recommendations             JSONB NOT NULL,              -- 例: {"X": {planCode,label,priceJpy,...}, "Y": {...}}
  review_status               TEXT NOT NULL DEFAULT 'new' CHECK (review_status IN ('new', 'contacted', 'closed')),
  notification_email_sent_at  TIMESTAMPTZ,                 -- NULLは通知未送信/失敗。admin一覧でのフラグ表示に使う
  source_ip                   TEXT,
  submitted_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_isms_diagnostic_submitted_at ON isms_diagnostic_submissions(submitted_at DESC);
CREATE INDEX idx_isms_diagnostic_review_status ON isms_diagnostic_submissions(review_status);
