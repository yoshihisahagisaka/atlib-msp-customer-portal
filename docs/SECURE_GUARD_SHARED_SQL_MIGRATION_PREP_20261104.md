# Secure Guard｜共通セキュリティCloud SQLへの移設準備・Read-only調査（2026-11-04）

## 状態・スコープ

採用済み方針：新設予定のSECU:MIE Cloud SQLインスタンスをSecure Guardと共用し、**SGは独立database/role/migration ledger**を保つ（`DECISION_ATLIB_SERVICE_PLATFORM_BOUNDARIES_20261104.md`）。

本書は**Gitのコード・DDLだけに基づく静的調査と実行前Runbook**。実機のProduction Ledger・row数・適用済みMigration 012/015は未確認。GCP、DB接続、Migration適用、Deploy、Slack送信、DNSFilter変更は一切実施していない。先行Draft PR #4のMigration 015は旧本番DBへ適用しない。

## 1. コード依存の実査（PR #4 HEAD `64191947efd9b1bf68573bbc408923eb62800652`）

Git tree内の `src/**/*.ts` と `migrations/*.sql` を対象にSGのDBテーブル名を全文照合。

| 直接SQL参照のあるコード | テーブル／用途 | 判定 |
|---|---|---|
| `src/services/secureGuardRepo.ts` | `portal_users`, `customer_organizations`, `customer_memberships`, `msp_role_grants`, `dnsfilter_organization_mappings`, `secure_guard_audit_events` | SGドメインのRepoにまとまっている |
| `src/services/secureGuardOverageStore.ts` | `secure_guard_overage_alerts`, `customer_organizations`, `dnsfilter_organization_mappings`, `secure_guard_audit_events` | 同一transaction・Org行lockが必要 |
| 上記以外の `src/**/*.ts` | 上記SG専用テーブルへの直接SQL文字列参照なし | **静的な直接依存は検出されない**。dynamic SQL・外部参照・本番の実態は別確認 |
| `migrations/011_secure_guard_identity_scope.sql` | SG個人認証・membership・org・DNSFilter mapping・receipt・audit | **旧 `customers` FKを含む** |
| `migrations/012_secure_guard_organization_independence.sql` | `customer_organizations` の `organization_name` 追加、`customer_id` nullable化、旧 `customers` FK削除 | 011と不可分の最終スキーマ |
| `migrations/015_secure_guard_overage_alerts.sql` | Org、本人へのFK、超過案件、一意索引、通知状態 | 011/012の最終状態を前提 |

`src/server.ts` は単一の既存 `createPool(config)` を、Portalの `CustomerRepo` 等とSGの `SecureGuardRepo`／`SecureGuardOverageStore` に注入する。現行 `src/db/pool.ts` はmax:5固定。SGログインは `SecureGuardIdentityService` からSG Repoを使い、独自セッションクッキーで現行Portalのcustomer/staff sessionから分離されている。

**暫定評価：SGの全業務データを一つの新databaseへまとめ、SG RepoとOverage Storeを同じSG専用poolへ切り替える方式が、超過案件だけを別DBへ切り出す方式より整合性を維持しやすい。** 「旧顧客ポータルのテーブルを一緒に全部移す」必要は静的参照からは示されない。改修量は従前の大規模分離想定より限定できる可能性がある。ただしProduction Ledgerと実データ・外部利用者の確認前にはFit確定しない。

## 2. 目標の最小設計（本番承認前）

1. 新設SECU:MIE共用**インスタンス**上にSG専用`secure_guard` database候補。 `secumie_insight`／将来`secumie_web`とはDB、Secret、SA、role、migration ledgerを分離。予算はSECU:MIE既定54＋SG追加分で再設計。
2. SG専用の新規baseline DDL（既存の011→012の**最終状態を再現**）とOverage DDLをSG専用migrationディレクトリで管理。旧Portal `customers`テーブルやグローバルmigration 001〜010を持ち込まない。旧 `customer_id` は必要な場合だけ参照IDとして保存し、旧DBへのFKを作らない。
3. SGの一連の8テーブル：`portal_users`、`customer_organizations`、`customer_memberships`、`msp_role_grants`、`dnsfilter_organization_mappings`、`secure_guard_receipts`、`secure_guard_audit_events`、`secure_guard_overage_alerts`（015は未適用なら旧側から移さず新DBへ初期作成）。適用状況をLedgerで決める。
4. 顧客情報／所属／招待token hash／session_version／receipt／auditのIDと関係を維持。名前・メール・秘密値・hashをレポートへ出力せず、移行処理では整合性検査と監査証跡を残す。
5. Portal本体の従来Poolは**現行通り維持**。SG Router/Identity/Repo/Overage StoreだけSG専用Poolへ配線。監視Jobも同じSG専用DBを使い、セッションロックと通知Claimを一つのDB内で維持する。無設定時は失敗を明示し、暗黙に別DBへfallbackしない方針（実装・段階切替時に本番互換性を検証）。
6. Cloud Runの単独revisionのpool設定だけでなく、最大instance数×SG pool、Job並行接続、切替時の旧新revision共存を接続予算に含める。SECU:MIE PR #42の50／54は**SGを含まない**。
7. DB切替時に認証済みsessionを無用に失効させない条件、管理画面／利用者への段階切替方法、移行中の書込み二重化要否と停止時間、旧DBのread-only保全・切り戻しを実データ量に応じて決定する。

## 3. Productionの最小Read-only調査（運用者による別途実行、現時点未実施）

既存 `docs/運用手順書_ポータルデプロイ.md` のCloud SQL Auth Proxy経路・read-only照合手順に従う。**本番ピーク22／最大25**であるため、短時間の追加接続であっても稼働時間帯・接続数余裕・運用責任者を確認してから実施。接続不可時に権限昇格・proxy再起動・別DB切替をしない。SQL内で秘密値・顧客レコード内容を出力しない。

初回はテーブル内容を読まず、schema/ledger/概算行数だけ照合。トランザクションをRead-onlyに設定し、短いstatement timeoutを設定する。各SQLは対象database名・ユーザー・権限の確認後にのみ実行。

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SELECT current_database() AS database_name, current_user AS db_user;
SELECT filename, applied_at
  FROM schema_migrations
 WHERE filename LIKE '011_%'
    OR filename LIKE '012_%'
    OR filename LIKE '014_%'
    OR filename LIKE '015_%'
 ORDER BY filename;
SELECT c.relname AS relation_name,
       c.reltuples::bigint AS estimated_rows,
       pg_total_relation_size(c.oid) AS storage_bytes
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relkind = 'r'
   AND c.relname IN (
     'portal_users', 'customer_organizations', 'customer_memberships',
     'msp_role_grants', 'dnsfilter_organization_mappings',
     'secure_guard_receipts', 'secure_guard_audit_events',
     'secure_guard_overage_alerts'
   )
 ORDER BY c.relname;
SELECT conrelid::regclass::text AS source_table,
       confrelid::regclass::text AS target_table,
       conname AS constraint_name
  FROM pg_constraint
 WHERE contype = 'f'
   AND connamespace = 'public'::regnamespace
   AND conrelid IN (
     SELECT c.oid FROM pg_class c
      WHERE c.relname IN (
        'portal_users', 'customer_organizations', 'customer_memberships',
        'msp_role_grants', 'dnsfilter_organization_mappings',
        'secure_guard_receipts', 'secure_guard_audit_events',
        'secure_guard_overage_alerts'
      )
   )
 ORDER BY source_table, target_table, constraint_name;
COMMIT;
```

`reltuples` は**推定**であり移行件数保証に使用しない。正式な移行対象確定時には、切替計画の承認後に対象テーブルごとの正確な件数・依存関係・整合性を限定取得する。もし `schema_migrations` が存在しない、異なるDBへ接続、Ledgerと実スキーマが不一致、014が適用済み、015が適用済みなど未想定があれば原因調査までSTOP。

## 4. Staging実装前に閉じるGate

| Gate | 完了条件 |
|---|---|
| 旧本番の適用履歴 | 011/012/014/015のledgerと実スキーマが一致 |
| SG-onlyの所有境界 | 既存Portalの非SG業務から直接/間接に参照するテーブルが特定され、影響を許容 |
| 新database baseline | 空のSG専用DBへDDL適用、再実行、FK/権限否定、旧スキーマ相当性を検証 |
| データ移行 | 旧→新のID・所属・token hash・receipt・audit整合、抜け漏れ、再試行の冪等性を検証 |
| 本体Pool分離 | Legacy Portalは従来DB、SG Router/JobはSG専用DB。SG DB停止がPPAP/非SG機能へ波及しない |
| 認可・ログイン | 既存session／invite／MSP管理／顧客scope／revocation／監査の回帰PASS |
| 共有接続予算 | SECU:MIE PR #42の54＋SG追加予算、role limit、内部接続、peak、revision共存、SECU Web将来増加が上限内 |
| 運用／切戻し | 合意済み短時間停止または整合した切替方式、旧DB保全、rollback可否、HA/PITR、責任者 |
| 監視仕様 | 超過表示・Slackの重複防止、API失敗判定維持、顧客対応履歴。請求機能なし |

## 5. Next Work

1. DB実機read-only証跡を受領し、移行元の実データ・Migration状態を確定。
2. SG-only新DB baseline／独立migration runner／接続config／dual-pool wiringの差分を別Draftに実装し、ユニット・実PostgreSQL E2Eを実施。
3. Insight基盤担当へ必要なSG role/Secret/接続上限を契約として渡し、SECU:MIE側で合計接続budgetとStaging費用を再承認。
4. 両サービスの独立Staging E2Eと旧→新データ移行リハーサルの結果を受けて、本番Go/No-Goを判断。

**今回行ったのはGitコードのread-only静的調査と文書化のみ。実環境GCP、DB、DNSFilter、Slackへの変更・実行なし。**
