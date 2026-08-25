-- 管理画面から編集できる運用設定（TimeRex予約リンク等）をDBで保持する。
-- key/valueの汎用テーブルにするのは、対象設定が増えてもマイグレーション追加なしで
-- 対応できるようにするため（ホワイトリストはコード側 src/domain/portalSettings.ts で管理する）。
-- 行が存在しないキーは「未設定＝env変数のデフォルト値を使う」という意味になる
-- （src/services/settingsRepo.tsの呼び出し側でフォールバックする）。

CREATE TABLE portal_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
