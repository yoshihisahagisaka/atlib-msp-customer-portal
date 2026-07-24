-- 月次レポート生成時に使うWANインターフェース設定(atlib_monthly_report.htmlの手動選択・
-- localStorage保存(atlib_wan_if_in/atlib_wan_if_out)を、将来のバッチ生成が参照できるよう
-- サーバー側にも保持するためのテーブル。既存の手動UI・localStorage自体は変更しない。
-- 003_ops_history.sqlの作法を踏襲(UUID PK + pgcrypto、TIMESTAMPTZ)

CREATE TABLE customer_report_settings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_code VARCHAR(20) NOT NULL UNIQUE REFERENCES customers(customer_code),
  wan_if_in     TEXT,   -- ZabbixアイテムID(WAN IN)
  wan_if_out    TEXT,   -- ZabbixアイテムID(WAN OUT)
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
