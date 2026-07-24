/**
 * 運用対応履歴の定型カテゴリ定義。
 * plan_quota_consumed（リモート運用プランの月4回枠を消費するか）の正式な判定基準は
 * プラン規約上まだ明文化されていない（実装指示書8節）。当面は入力画面のチェックボックスで
 * 運用者の裁量に委ね、基準が確定次第カテゴリごとの既定値付与などに拡張する。
 */
export const OPS_HISTORY_CATEGORIES = [
  'VPNアカウント追加削除',
  'Wi-Fiパスワード変更',
  '機器再起動対応',
  '障害切り分け・トラブル対応',
  'その他',
] as const;

export type OpsHistoryCategory = (typeof OPS_HISTORY_CATEGORIES)[number];
