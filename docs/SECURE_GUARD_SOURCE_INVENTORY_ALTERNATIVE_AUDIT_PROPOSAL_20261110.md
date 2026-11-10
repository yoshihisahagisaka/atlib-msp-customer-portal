# Secure Guard Source Inventory｜本番Bootstrap代替監査 B案（2026-11-10・提案）

> **状態：設計案の作成のみ承認。監査要件の正式変更は未承認。P1=STOP、Production No-Go、Draft PR #5を維持。**
> 本書はDB再起動を避けるための代替監査の審査資料であり、Stage A/B、Cloud Run Jobの配備・実行、IAM/Secret/DB変更の実行許可ではない。

## 1. 正本と適用範囲

- 正本：[Role/Stage A/Bの判断・保証境界](SECURE_GUARD_SOURCE_INVENTORY_ROLE_APPROVAL_20261106.md)／[Production Preflight P0〜P6](SECURE_GUARD_SOURCE_INVENTORY_PRODUCTION_PREFLIGHT_20261110.md)／Draft PR #5。
- 対象は `msp-zabbix / msp-customer-portal-db / msp_customer_portal`（PostgreSQL 16）、候補role `sg_source_inventory_ro_20261106` の**初期Bootstrapのみ**。
- Stage A候補：正規の`postgres`管理経路から`NOLOGIN NOINHERIT PASSWORD NULL` role作成、対象DB `CONNECT` / `public` schema `USAGE`。Stage B候補：所有者`portal_app`の一回限りの固定Cloud Run Jobによる `public.schema_migrations` の `SELECT` GRANT 1件。
- LOGIN化、Password設定、Source Inventory実行、Migration、SG Staging、本番切替、復旧操作は**別Gate・本案の対象外**。
- **変更しない事項**：固定SQL・SHA照合、非root/Distroless Node24 runner、専用SA最小権限、Secret Version 1のファイルmount、retry=0、Schedulerなし、二段階の独立承認、結果不明STOP、最終ACL照合、PASSWORD NULLの`NOT_DIRECTLY_VERIFIED`。

## 2. 実環境Read-only証跡とP1判定（2026-11-10）

すべて運用者が`gcloud.cmd`で取得した結果の報告であり、本書作成側はGCP変更・実DB接続をしていない。

| 項目 | 観測した値 | 判定と限界 |
|---|---|---|
| インスタンス | `POSTGRES_16` / `RUNNABLE` | 当該観測時点は正常 |
| `settings.databaseFlags` | describe応答に表示なし | `cloudsql.enable_pgaudit=on`の証拠なし。実効SQL監査のGateは未成立 |
| 可用性 | `ZONAL` | フラグ変更に伴う再起動は共有本番サービスの停止リスク |
| Backup/PITR | 自動Backup有効・保持30（COUNT）、PITR有効、WAL保持7日 | 設定PASS。復元試験・戻し先・復旧担当は未実証 |
| 最新バックアップ | 2026-11-09 20:02:48 UTC終了、`SUCCESSFUL`。直近5件が成功 | 実取得はPASS。restore可能性の証明ではない |
| Storage | `dataDiskSizeGb=10`、`storageAutoResize=true`、`storageAutoResizeLimit=0` | 自動拡張有効。使用率・増分費用の判定ではない |
| Operations | 直近10件すべて`DONE`（最新は2026-11-09 20:01 UTCの`BACKUP_VOLUME`） | 表示範囲で未完了なし。実行直前の全体状態を保証しない |

Google Cloud公式では、`cloudsql.enable_pgaudit`フラグ変更はインスタンス再起動を伴う：
[Cloud SQL pgAudit](https://cloud.google.com/sql/docs/postgres/pg-audit)。
現在のP1にある「実効ROLE文監査」をPASSにする証拠はないため、**P1はSTOPのまま**。

## 3. B案の監査証跡契約（直接SQL文監査の代替候補）

| 境界 | 実行前（保全） | 実行中（保全） | 実行後（独立照合） |
|---|---|---|---|
| Stage A / `postgres` | 承認ID/実行者/時刻、SQLとCommit SHA、固定SQLのSHA256、DB/role/ACL Before、接続余裕/依存サービス状態 | 正規管理経路の操作記録、開始・終了時刻、成功/中断分類。Secret/業務行/パスワードをログ化しない | `pg_roles`属性、対象DB CONNECT・public USAGE、Ledger SELECTなし、不要権限なし、ACL After。結果不明なら再実行禁止 |
| Stage B / `portal_app` | 別の承認ID、Build ID/source Commit/固定SQL SHA256、Image Digest、Job export hash、runtime SA・Secret version・IAM、ACL Before、二者レビュー | Cloud Run Execution ID/Task/時刻、固定runnerのENTER/COMPLETE/STOP code、Cloud Audit Logsの管理操作ログ。SQL本文やSecretはログ化しない | **別主体**によるLedger SELECTのgrantee=`sg_source_inventory_ro_20261106`、grantor=`portal_app`、grantable=false、3権限・不要権限/role membershipなし、ACL After |
| Final verify | Read-only主体の承認/接続先/時刻 | 既存`secureGuardSourceInventoryRoleFinalVerify.sql`の定型出力 | `direct_runtime_checks=PASS`と`password_null_runtime_status=NOT_DIRECTLY_VERIFIED`、`password_null_assurance=STAGE_A_DDL_AND_POSTGRESQL16_CI`の**3値を一緒に保存** |

- Stage A/Bは**別々の実行者・承認者・時刻・証跡**を保持し、Stage Aの成功でStage Bの承認を流用しない。
- 実行証跡の連結キー候補は、承認ID、Git Commit、SQL SHA256、Artifact Digest、Job export hash、Execution ID、時刻窓、前後ACL digest。各値は改ざん防止のため変更管理されたPR/承認票と照合する。
- Job Executorは再実行可能な権限であり、`APPROVED_ONCE`も一回性の強制ではない。P4まで実行権限を与えず、実行後の回収は別審査する。
- COMPLETEログだけでは完了扱いしない。タイムアウト・結果不明・ログ欠損・ACL不一致・SQL/Job/IAM drift・予期せぬ第三者操作の疑いは**STOP**し、DBはRead-onlyで分類する。自動再実行・自動修復なし。
- 証跡の閲覧可能者、保持期間、保存先、タイムスタンプ同期、原本ハッシュと二者レビューの責任者は、正式採用前に実名・設定を記録する。

## 4. 監査保証の差分（重要）

| 観点 | pgAuditを有効にした場合 | 提案B案（DB文監査なし） |
|---|---|---|
| `CREATE ROLE` / `GRANT` の実際のSQL文ごとのDB記録 | 設定・配送が有効なら取得可能 | **取得できない**。固定SQLとJob/操作実績、ACL結果からの間接推定に限る |
| 操作者・対象・実行時刻 | DBセッションの監査と照合可能 | Cloud Run/管理操作・実行者記録とDB前後状態を突合。DB側セッションの直接証明ではない |
| 他のSQLが同時に走らなかったこと | ログ対象の範囲内で調査可能 | **否定を証明できない**。他管理者・別経路の操作は残余リスク |
| 最終権限状態 | ACL確認可能 | ACLを直接確認可能 |
| DB再起動 | 有効化時に必要 | **B案にDBフラグ変更を含めない**。ただしDB操作時の通常負荷・ロックリスクは残る |

**B案はpgAuditと同等の監査ではない。** 管理操作ログやJobログにDB文そのものが自動記録されると誤記しない。正式採用するなら「単発Bootstrap限定の代替保証」「SQL文単位の証跡がない残余リスク」「受容責任者」を明示した監査契約の変更承認が必要。

## 5. 正式採用に向けた判断Gate（現在はすべて未解除）

1. **監査方式の別承認**：P1の「DB statement audit必須」を、**当該単発Bootstrapだけ**B案に置き換えるか統括が判断。承認者、対象期間、残余リスク、証跡保持先と期間を確定する。**本書の作成承認はこの承認を兼ねない。**
2. **P1再審査**：監査方式承認後も、接続/CPU/負荷、Backup/PITRと復旧経路、Portal/PPAP/Sales Toolsの正常性、担当・二者レビュー・証跡保持を実行時点で検証。未達ならSTOP。
3. **P2別承認**：専用SA/IAM、Image Build/Push、Cloud Run Jobの**作成のみ**。Secret payload取得、Job実行なし。
4. **P3別承認**：Stage Aのrole作成/CONNECT/USAGEを対象・時刻・担当固定で承認。
5. **P4別承認**：Stage B Jobを別途1回だけ承認。結果不明は再実行禁止。
6. **P5独立確認**：ACL / role attributesのDirect確認。PASSWORD NULLはIndirect/Not directly verifiedを併記。P6のLOGIN・Inventory・Migrationは別途No-Go。

## 6. 今回の変更範囲・決定待ち

- **今回実施：文書上のB案提案と2026-11-10のRead-only観測値の記録のみ。**
- **今回実施しない：pgAuditフラグ変更、DB再起動、`CREATE EXTENSION`、本番DB書込み、`CREATE ROLE`/GRANT/REVOKE、IAM/Secret/Cloud Run Job/Artifact変更、Stage A/B/Final verify、Source Inventory、Migration、PR merge。**
- **結論：代替監査B案はReview待ち。P1=STOP / P2〜P6=No-Go / Production No-Go / Draft PR #5維持。**
