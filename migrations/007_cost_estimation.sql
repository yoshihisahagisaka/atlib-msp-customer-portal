-- 原価見積ツール（社内スタッフ専用、/admin/*配下）
-- 006_customer_applications.sqlの作法を踏襲（UUID PK + pgcrypto、TIMESTAMPTZ、enumの代わりにCHECK）
--
-- カテゴリはネットワーク構築/サーバー構築/PCキッティング/システム開発/その他の5値で、
-- market_rates・estimate_preconditions・estimatesの3テーブルで共通利用する。

CREATE TABLE market_rates (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category           TEXT NOT NULL CHECK (category IN ('network', 'server', 'kitting', 'dev', 'other')),
  item_name          TEXT NOT NULL,
  unit               TEXT NOT NULL,                 -- 例: 台, 式, 人日
  price_low          NUMERIC(12,0) NOT NULL CHECK (price_low >= 0),
  price_high         NUMERIC(12,0) NOT NULL CHECK (price_high >= price_low),
  price_recommended  NUMERIC(12,0) CHECK (price_recommended IS NULL OR price_recommended BETWEEN price_low AND price_high),
  source_note        TEXT,
  is_active          BOOLEAN NOT NULL DEFAULT true,  -- 廃止相場のソフト削除（過去見積からの参照を残すためDELETEしない）
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (category, item_name, unit)                 -- CSV再取込時のON CONFLICT DO UPDATEのキー
);
CREATE INDEX idx_market_rates_category ON market_rates(category);
CREATE INDEX idx_market_rates_active ON market_rates(is_active);

CREATE TABLE estimate_preconditions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category    TEXT NOT NULL CHECK (category IN ('network', 'server', 'kitting', 'dev', 'other')),
  label       TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,          -- ソフト削除（見積側はlabelスナップショットを持つため遡及影響なし）
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_estimate_preconditions_category ON estimate_preconditions(category);

CREATE TABLE estimates (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title                      TEXT NOT NULL,
  customer_name              TEXT,                    -- 自由記述。既存customersテーブルへのFKにはしない
                                                        -- （見積段階では未オンボーディングの見込み客が大半のため）
  category                   TEXT NOT NULL CHECK (category IN ('network', 'server', 'kitting', 'dev', 'other')),
  status                     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'archived')),
  default_risk_coefficient   NUMERIC(4,2) NOT NULL DEFAULT 1.15 CHECK (default_risk_coefficient > 0),
  notes                      TEXT,
  created_by                 TEXT,                    -- スタッフ個別アカウントが無いため自由記述（Basic Auth共有と同じ制約）
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_estimates_status ON estimates(status);
CREATE INDEX idx_estimates_category ON estimates(category);
CREATE INDEX idx_estimates_created_at ON estimates(created_at DESC);

CREATE TABLE estimate_line_items (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_id                 UUID NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  cost_type                   TEXT NOT NULL CHECK (cost_type IN ('fixed', 'variable')),  -- 固定費/変動費
  item_name                   TEXT NOT NULL,
  unit                        TEXT,
  quantity                    NUMERIC(12,2) NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  unit_cost                   NUMERIC(12,0) NOT NULL CHECK (unit_cost >= 0),   -- スタッフ入力の見積提示単価
  risk_coefficient_override   NUMERIC(4,2) CHECK (risk_coefficient_override IS NULL OR risk_coefficient_override > 0),
                                                        -- NULLならestimates.default_risk_coefficientを使用。固定費は運用上常にNULL
  market_rate_id               UUID REFERENCES market_rates(id) ON DELETE SET NULL,  -- 参照した相場行（任意）
  sort_order                   INTEGER NOT NULL DEFAULT 0,
  memo                         TEXT,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
  -- 将来、実費（actual_cost）を追加する場合は素直に
  -- ALTER TABLE estimate_line_items ADD COLUMN actual_cost NUMERIC(12,0); で足りる設計にしてある
);
CREATE INDEX idx_estimate_line_items_estimate_id ON estimate_line_items(estimate_id);
CREATE INDEX idx_estimate_line_items_market_rate_id ON estimate_line_items(market_rate_id);

CREATE TABLE estimate_selected_preconditions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_id      UUID NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  precondition_id  UUID REFERENCES estimate_preconditions(id) ON DELETE SET NULL,  -- マスタ削除後も履歴を保持
  label            TEXT NOT NULL,          -- 選択時点のラベルをスナップショット（マスタ編集の遡及影響を防ぐ）
  is_ad_hoc        BOOLEAN NOT NULL DEFAULT false,  -- マスタ未登録のその場入力
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_estimate_selected_preconditions_estimate_id ON estimate_selected_preconditions(estimate_id);
