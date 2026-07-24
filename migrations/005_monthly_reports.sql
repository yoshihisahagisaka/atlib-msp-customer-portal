-- 月次レポートの生成状況・承認ワークフロー管理用テーブル。
-- 004_customer_report_settings.sqlの作法を踏襲(UUID PK + pgcrypto、TIMESTAMPTZ)

CREATE TABLE monthly_reports (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_code  VARCHAR(20) NOT NULL REFERENCES customers(customer_code),
  report_period  VARCHAR(7) NOT NULL,   -- 'YYYY-MM'
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'sent', 'failed')),
  file_path      TEXT,                  -- gs://<bucket>/<customer_code>/<period>.pptx
  error_message  TEXT,                  -- status='failed'時の詳細
  generated_at   TIMESTAMPTZ,
  approved_by    TEXT,
  approved_at    TIMESTAMPTZ,
  sent_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(customer_code, report_period)
);

CREATE INDEX idx_monthly_reports_status ON monthly_reports(status);
