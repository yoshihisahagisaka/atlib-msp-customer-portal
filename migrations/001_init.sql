-- msp-customer-portal 初期スキーマ
-- 設計書 (msp-frontend-server/msp_frontend_design.md) のDDLをPostgres方言へ翻訳したもの。
-- 差分: VARCHAR(36)->UUID, DATETIME->TIMESTAMPTZ, ENUM->CHECK制約

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 顧客アカウント
CREATE TABLE customers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_code   VARCHAR(20) UNIQUE NOT NULL,   -- 内部管理用の英数字ID（例: atlib001）。Zabbix上の表示名（日本語可）とは別管理
  company_name    VARCHAR(255) NOT NULL,         -- Zabbix側のホストグループ名に使う表示名（例: atLIB株式会社様）
  email           VARCHAR(255) UNIQUE NOT NULL,  -- ログインID兼連絡先
  password_hash   VARCHAR(255) NOT NULL,
  zabbix_userid   VARCHAR(20) NOT NULL,          -- 顧客通知用ZabbixユーザーID
  zabbix_proxy_id VARCHAR(20),                   -- 顧客環境のZabbix Proxy ID
  zabbix_actionid VARCHAR(20),                   -- 顧客専用Action ID
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 顧客とZabbixホストグループの対応（1顧客が複数グループを持つケースに対応。例: 本体 + プラン別サブグループ）
CREATE TABLE customer_hostgroups (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  zabbix_groupid  VARCHAR(20) NOT NULL,          -- 例: MSP/atLIB株式会社様 の groupid
  group_name      VARCHAR(255) NOT NULL,         -- 例: "MSP/atLIB株式会社様 エントリープラン"
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_customer_hostgroups_customer_id ON customer_hostgroups(customer_id);

-- パスワードリセットトークン
CREATE TABLE password_reset_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token_hash  VARCHAR(255) NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_password_reset_tokens_customer_id ON password_reset_tokens(customer_id);
