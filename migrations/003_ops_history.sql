-- 運用対応履歴（月次レポートの「運用対応履歴＆工数管理」欄に自動流し込みするための記録用テーブル）
-- 001_init.sql/002_isms_diagnostic.sqlの作法を踏襲（UUID PK + pgcrypto、TIMESTAMPTZ）
-- customer_codeはcustomers(customer_code)（UNIQUE制約あり）を参照する（idではなくcode参照。
-- レポート生成バッチがcustomer_codeのみを持って呼び出す運用のため）

CREATE TABLE ops_history (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_code         VARCHAR(20) NOT NULL REFERENCES customers(customer_code),
  occurred_at           TIMESTAMPTZ NOT NULL,               -- 対応日時
  category              TEXT NOT NULL,                      -- 例: 'VPNアカウント追加削除' 'Wi-Fiパスワード変更' 'その他'
  description           TEXT,                                -- 自由記述（category='その他'の場合は入力必須をUI側で担保）
  operator               TEXT NOT NULL,                       -- 対応者（atLIB担当者名）
  minutes_spent          INTEGER NOT NULL DEFAULT 0,
  plan_quota_consumed    BOOLEAN NOT NULL DEFAULT true,       -- リモート運用プランの「月4回まで」枠を消費する対応かどうか
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ops_history_customer_period ON ops_history(customer_code, occurred_at);
