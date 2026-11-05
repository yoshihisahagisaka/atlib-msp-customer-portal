# Secure Guard｜SECU:MIE共通Cloud SQL Staging合流契約（2026-11-05）

## 位置付け

- 既決定：案②。SECU:MIE（Insight主管）の新Cloud SQL**インスタンス**へSecure Guardの**独立database/role**を収容。
- 既存Portal、Sales Tools、PPAP/Secure Send本番DBは不変更。Secure Sendの将来分離は別工程。
- SECU:MIE Draft PR #42（共通インスタンス設計）、#43（runtime接続分離）、#44（SECU専用Staging構築手順）を継承する。各PRのSECU:MIE単独検証をSGとの共用構成Goとみなさない。
- 本文はSecure Guard側の実装候補とInsight側へのインターフェース要求。**Staging作成、DB作成、権限付与、Migration実行、実データ移行、本番変更は未実施。**

## 責任境界

| 項目 | Insight側 | Secure Guard側 |
|---|---|---|
| Cloud SQLインスタンス | Staging・本番構築、Tier/HA、接続上限、監視、費用、バックアップ・PITR統括 | SG接続見積と負荷・運用要件を提示 |
| SG database | DB作成、接続先と権限隔離、Secret・SA配布の調整 | SG固有テーブル定義、アプリDB機能 |
| DB principal | 個別runtime/DDLロールと最小権限の付与管理 | runtimeからDDL権限を排除、独立Migration ledger・runner |
| Migration/データ移行 | 共通Stagingと復旧条件の調整 | 新規SG baseline、旧→新データ整合、切替・切戻し |
| 障害/復旧 | **インスタンス単位**で初動・PITR統括 | SG側整合性・セッション・監査・通知状態の復旧確認 |

## SG専用database（作成候補、要調整）

- DB名 `secure_guard`。実際の命名・DB作成者はInsight側と調整。
- ①`secure_guard_runtime`：SG専用テーブルの必要なDMLのみ。`CREATEDB`、`CREATEROLE`、DDL、他サービスDB権限なし。
- ②`secure_guard_ddl`：**明示承認された**SG migration時のみ使用。runtimeと別Secret/role。
- 移設対象は8テーブル（個人認証、Organization、membership、MSP grant、DNSFilter mapping、receipts、audit、overage）。013以前の旧PortalマイグレーションをSG DBに流用しない。
- SG専用SQL `migrations/secure_guard/001_identity_scope_baseline.sql` と `002_overage_alerts.sql`。独立ledger `secure_guard_schema_migrations`。旧Portal `customers` FKなし。
- SG専用runner `migrations/secure_guard_runner.ts` は `SECURE_GUARD_MIGRATION_APPROVED=true` と専用migration credentialを必須とし、ledgerとSHA256を検証。**既存の `npm run migrate` をSG専用DBへ向けることを禁止。**

## Runtime接続と切替Gate

- 現行Portal側のpool(max 5/instance)は変更せず、SG Repo・Overage Storeにだけ別pool(max **2/instance**)を渡す。Overage JobもSG DBにのみ書込む。
- `SECURE_GUARD_DB_MODE=dedicated` を明示した場合、別接続先・DB名・runtimeユーザー・passwordをすべて要求。欠落時は例外となり、旧DBへfallbackしない。
- 既存サービスの段階移行前は互換性のため`legacy`がデフォルト。**本番切替時は**`SECURE_GUARD_DB_REQUIRE_DEDICATED=true`を設定して、env消失による旧DBへの暗黙復帰を防ぐ。
- 接続経路は `SECURE_GUARD_DB_SOCKET_PATH`（Cloud SQL socket）か `SECURE_GUARD_DB_HOST`/`SECURE_GUARD_DB_PORT`（TCP）の片方のみ。
- `SECURE_GUARD_DB_NAME`、`SECURE_GUARD_DB_USER`、`SECURE_GUARD_DB_PASSWORD` はPortalの `DB_*` を使い回さない。Secret値はPR・ログに記録しない。
- 新SQLを未接続でもPortal全体の `/healthz` はSGの生存確認にならないため、Stagingでは**SGログイン・権限・管理・監査・Jobの専用E2Eを必須**とする。

## 合計接続予算（未承認）

SECU:MIE PR #42の**54**はSECU:MIE単独予算。SGの許容上限ではない。SG runtime `R=2`、SG最大Web instance数 `N`、Job並行数 `J`、移行DDL `D=1`を仮定する。

通常のSG追加接続予算候補は `S_normal = 2*N + 2*J`。切替時に旧・新Revisionがともに新SG DBを参照する場合は `S_cutover = 4*N + 2*J + 1` を上限候補として確認する（実際のtraffic分割・最大instance数に合わせて精査）。

**共用インスタンスの許容量は `54 + max(S_normal,S_cutover)` に、必要な内部接続・保守/障害対応の余裕を確保する。** PostgreSQL設定上のmax_connectionsだけでなくCloud SQLの実利用可能枠とメモリを再評価する。将来の利用企業数・API監視頻度・データ量・共通障害影響を含め、1 vCPU / 3.75 GiB を無条件確定しない。

## Staging開始に向けた接続条件

1. Insight側が**新Cloud SQL Stagingインスタンス**の実作成と接続予算を承認し、SG用database/roleの作成可否を明示する。
2. SG側が空の**SG専用Staging DB**だけへ独立migrationを実施し、再実行・checksum不一致・余分な権限の拒否を検証。
3. 既存Portal Stagingが存在しなかった点を解消し、legacy DBの仮想/安全なテスト環境を用意してSG dual poolだけを検証。**既存本番Portal DBへテスト負荷を加えない。**
4. 旧本番のProduction Ledger（011/012/014/015）と対象データの実件数・FKを**低負荷Read-only**で照合した後、全8テーブルのID/関連/監査等を保全する移行スクリプトとRollbackを決める。
5. SGの過去session・invitation・MSP権限・通知二重防止までStaging E2E PASSとし、Insight側と共通障害/PITR復旧責任者を確認してからProduction Go/No-Go判定。

**本PRはSG側のオフライン実装準備。SECU:MIE Staging作成や本番切替の許可を代行するものではない。**
