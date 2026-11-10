# Secure Guard Source Inventory｜本番Bootstrap代替監査 B案（2026-11-10・限定採用）

> **状態：監査方式B案を2026-11-10に今回一回限りで正式採用（Decision `SG-SOURCE-INV-AUDIT-B-20261110`）。ただしP1=STOP、Production No-Go、Draft PR #5を維持。**
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

## 3. B案の監査証跡契約（今回一回限りの採用契約）

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

## 5. 採用後にも必要なGate（P1〜P6は未解除）

1. **監査方式の限定採用：承認済み**。決定は[Decision `SG-SOURCE-INV-AUDIT-B-20261110`](DECISION_SECURE_GUARD_SOURCE_INVENTORY_AUDIT_B_20261110.md)。対象は当該一回限りのBootstrapだけ。証跡保持先・期間・二者レビューはP1残存Gateであり、採用決定だけではP1は解除されない。
2. **P1再審査**：監査方式承認後も、接続/CPU/負荷、Backup/PITRと復旧経路、Portal/PPAP/Sales Toolsの正常性、担当・二者レビュー・証跡保持を実行時点で検証。未達ならSTOP。
3. **P2別承認**：専用SA/IAM、Image Build/Push、Cloud Run Jobの**作成のみ**。Secret payload取得、Job実行なし。
4. **P3別承認**：Stage Aのrole作成/CONNECT/USAGEを対象・時刻・担当固定で承認。
5. **P4別承認**：Stage B Jobを別途1回だけ承認。結果不明は再実行禁止。
6. **P5独立確認**：ACL / role attributesのDirect確認。PASSWORD NULLはIndirect/Not directly verifiedを併記。P6のLOGIN・Inventory・Migrationは別途No-Go。

## 6. 2026-11-10 設計提案時点の記録（履歴）

- **今回実施：文書上のB案提案と2026-11-10のRead-only観測値の記録のみ。**
- **今回実施しない：pgAuditフラグ変更、DB再起動、`CREATE EXTENSION`、本番DB書込み、`CREATE ROLE`/GRANT/REVOKE、IAM/Secret/Cloud Run Job/Artifact変更、Stage A/B/Final verify、Source Inventory、Migration、PR merge。**
- **当時の結論：代替監査B案はReview待ちだった。その後、同日付Decisionで今回一回限りの採用が承認された。P1=STOP / P2〜P6=No-Go / Production No-Go / Draft PR #5維持は変わらない。**

## 7. 正式採用決裁欄（2026-11-10・監査方式のみ承認済み）

### 統括が判断する監査契約の限定変更

**承認された決定文：** `msp-customer-portal-db / msp_customer_portal`の`sg_source_inventory_ro_20261106`を初期作成する**Stage Aと、Ledger SELECT 1件を付与するStage Bの一回限り**に、pgAudit文監査の代替として本書のBefore/実行中/After証跡突合を採用する。次の残余リスクを承知して受容し、証跡条件が未達なら即時STOPとする。これはDB監査一般の免除ではなく、LOGIN化・Source Inventory・Migration・復旧には波及しない。

**受容済みの残余リスク（いずれもB案では解消しない）：**

1. DBが実行した`CREATE ROLE` / `GRANT` SQL本文の直接監査ログはなく、実行した文とGit固定SQLの同一性は間接的にしか説明できない。
2. Stage Aの管理経路やStage B Job以外による同時/第三者SQL操作を、B案の証跡だけで完全には否定できない。
3. Cloud Run Jobの実行権限は「一回限り」の技術的強制ではなく、運用上の別承認・事後権限回収に依存する。DB変更の結果不明、時刻窓の欠損、ログ保存失敗で実行経過を再構成できなくなる可能性がある。

### 採用後にも必須となる確認（条件未達ならP1=STOP）

| 分類 | 実行前に確定すべきもの | 現状 |
|---|---|---|
| 人的統制 | 監査方式の受容責任者、P1二者照合者、Stage A実行者、Stage B配置担当/実行担当、復旧責任者 | **未指定** |
| 原本証跡 | 承認IDとUTC/JST、PR HEAD/SQL SHA、Stage A管理経路の操作記録、ACL before/after、Stage B Job export hash/image digest/Execution ID/定型log、Cloud Audit Logs参照と原本保全 | **保全場所・閲覧権限未確定** |
| 保持 | 証跡保存先、保持期間、原本ハッシュ/改変防止、アクセス権、証跡の欠損時STOP | **未確定** |
| 復旧 | Backup/PITRの最新成功と承認された復旧先・担当・手順。復元試験未実施の限界を記録 | **復元能力は未実証** |
| 本番正常性 | 実行直前のDB操作、接続余裕/CPU、Portal/PPAP/Sales Tools Ready/5xx、変更凍結ウィンドウ | **再測定待ち** |

- 原本ログの機密値をGitへ貼らない。PRにはSecretを含まない要約、各原本の参照ID・ハッシュ、確認者/時刻を記録する。既存の保全先と権限が使えるかをP1で確認する。**新規Bucket/Logging設定の作成を本承認に含めない。**
- Stage AとStage Bの承認IDを分離し、互いに代用しない。独立のFinal verifyによるDirect結果とPASSWORD NULL間接保証を併記して初めて完了候補とする。
- これらが整わなければ、B案を形式上採用しても**P1=STOP**のまま。P2以降は個別の本番変更承認が必要。

### 決裁記録（採用決定済み、実行承認なし）

| 項目 | 記録 |
|---|---|
| 採用可否 | **ACCEPTED：今回一回限りの監査方式B案のみ** |
| 適用範囲 | 上記一回限りのStage A / Stage Bの初期Bootstrapのみ |
| 受容する残余リスク | 上記3点。DB文監査と同等ではない |
| 決裁者・決裁日時・決裁ID | 萩坂（統括）／2026-11-10／`SG-SOURCE-INV-AUDIT-B-20261110` |
| 証跡保持場所・期間・二者レビュー担当 | **未記入（P1停止条件）** |
| 実行権限 | **0件。この決裁はP2〜P6の実行を許可しない** |

**次の工程：** 監査方式は正式採用済み。P1の人的統制・証跡の保全先/期間・復旧/稼働状態の未充足をRead-onlyで確認し、二者照合を準備する。条件が揃うまでProduction No-Goを維持し、P2〜P6は別承認する。
