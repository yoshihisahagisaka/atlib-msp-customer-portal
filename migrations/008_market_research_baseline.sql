-- market_ratesに「外部市場調査ベースライン」と「そこからの当社調整」を記録する列を追加。
-- 背景: これまでprice_low/price_high/price_recommendedは社内の過去見積実績（CSV取込）か
-- 手入力のみが源泉で、「外部の実勢相場（積算資料等の刊行物、競合価格等）を調査した上で
-- 当社独自の掛け率・調整を加えて価格を決めた」という調達プロセスを表現できていなかった。
-- price_low/high/recommendedの意味は変更しない
-- （＝evaluateMarketRateFlagやaiAssistServiceのプロンプトが参照する「当社の実効価格帯」のまま）。
--
-- source_noteは既存データで「社内引用元」と「その他メモ」が混在した使われ方をしているため
-- 意味を変えず、外部調査の出典（URL・刊行物名等）は新規列market_research_sourceに分離する
-- （既存行のsource_noteを書き換えずに済み、後方互換）。
--
-- 調整係数(adjustment_coefficient)は参考値の記録用であり、price_*を自動計算する仕組みは
-- 設けない（過剰実装を避ける。「baseline × 1.15」のような根拠を残すだけで十分と判断）。

ALTER TABLE market_rates
  ADD COLUMN market_baseline_low         NUMERIC(12,0)
    CHECK (market_baseline_low IS NULL OR market_baseline_low >= 0),
  ADD COLUMN market_baseline_high        NUMERIC(12,0)
    CHECK (market_baseline_high IS NULL OR market_baseline_low IS NULL OR market_baseline_high >= market_baseline_low),
  ADD COLUMN market_baseline_recommended NUMERIC(12,0)
    CHECK (
      market_baseline_recommended IS NULL
      OR (market_baseline_low IS NOT NULL AND market_baseline_high IS NOT NULL
          AND market_baseline_recommended BETWEEN market_baseline_low AND market_baseline_high)
    ),
  ADD COLUMN market_research_source      TEXT,     -- 外部調査の出典（URL・刊行物名など）。source_noteとは別に社外引用元を明示する
  ADD COLUMN adjustment_coefficient      NUMERIC(6,3)
    CHECK (adjustment_coefficient IS NULL OR adjustment_coefficient > 0);
    -- 例: baseline_recommended × 1.15 ≒ price_recommended、といった掛け率の記録用（参考値。自動計算はしない）
